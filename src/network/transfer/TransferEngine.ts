import type { EventSubscription } from 'react-native';
import { FileTransfer, FortShareFs } from '../../native';
import type {
  ReceiveCompleteEvent,
  SendCompleteEvent,
  TransferErrorEvent,
  TransferProgressEvent,
} from '../../native';
import { ACK_INTERVAL_BYTES, PART_SUFFIX } from '../../constants/protocol';
import { deviceRepository, transferRepository } from '../../database/repositories';
import type {
  AcceptedFile,
  ControlMessage,
  OfferedFile,
  TransferOfferMessage,
  ResumeStateMessage,
} from '../../models/protocol';
import type {
  ActiveTransfer,
  DuplicateResolution,
  SelectedFile,
  TransferFileRecord,
  TransferPauseReason,
  TransferRecord,
} from '../../models/transfer';
import { digestsMatch, randomId } from '../../services/crypto';
import { logger } from '../../services/log';

const log = logger('transfer');
import { SessionManager, type PeerSession } from '../session/SessionManager';
import { SpeedTracker } from './speed';

/**
 * Asked when an incoming file would overwrite an existing one (§26).
 * Resolves with what to do; the decision is made *before* any byte moves.
 */
export type DuplicateResolver = (
  fileName: string,
  size: number,
) => Promise<DuplicateResolution>;

/**
 * The answer to an incoming offer, with the reason for a refusal.
 *
 * The reason is sent to the other device and shown to that user, so it has to
 * be true: "declined by the user" when nobody declined points the sender at
 * entirely the wrong problem.
 */
export type ApprovalResult =
  | { accepted: true }
  | { accepted: false; reason: string };

/** Asked before accepting an incoming transfer (§15: transfer authorization). */
export type TransferApprover = (
  session: PeerSession,
  offer: TransferOfferMessage,
) => Promise<ApprovalResult>;

interface TransferContext {
  record: TransferRecord;
  files: TransferFileRecord[];
  session: PeerSession | null;
  speed: SpeedTracker;
  currentFileIndex: number;
  filesCompleted: number;
  filesFailed: number;
  /** Set while the engine is deliberately stopping, so drops are not errors. */
  stopping: TransferPauseReason | null;
  /** Resolves the send loop when the peer settles the file it is blocked on. */
  waiters: Map<string, () => void>;
  /** Receiver only: bytes at which we last sent CHUNK_ACK, per fileId. */
  lastAck: Map<string, number>;
}

type TransferListener = (transfer: ActiveTransfer) => void;
type CompletionListener = (record: TransferRecord) => void;

/**
 * Drives transfers end to end (§18-§21).
 *
 * The engine is the *coordinator*, not the mover: it negotiates what to send,
 * tells native to stream a file from a given offset, and reacts to throttled
 * progress events. File bytes never pass through here.
 */
class TransferEngineImpl {
  private contexts = new Map<string, TransferContext>();
  private subscriptions: EventSubscription[] = [];
  /**
   * Unsubscribes for the SessionManager listeners.
   *
   * These used to be discarded, so `stop()` left them registered and a later
   * `start()` added more. Every control frame was then handled twice — and a
   * duplicated TRANSFER_OFFER was fatal: the first showed the approval
   * prompt, the second saw that prompt already open and auto-declined, so the
   * sender was told "declined by the user" while the receiver was still
   * looking at the dialog.
   */
  private sessionUnsubscribes: (() => void)[] = [];
  private started = false;

  private approveTransfer: TransferApprover = async () => ({
    accepted: false,
    reason: 'FortShare is still starting up',
  });
  private resolveDuplicate: DuplicateResolver = async () => 'keep-both';

  private listeners = new Set<TransferListener>();
  private completionListeners = new Set<CompletionListener>();

  start(options: {
    approveTransfer: TransferApprover;
    resolveDuplicate: DuplicateResolver;
  }): void {
    this.approveTransfer = options.approveTransfer;
    this.resolveDuplicate = options.resolveDuplicate;

    if (this.started) return;
    this.started = true;

    this.subscriptions.push(
      FileTransfer.onSendProgress((event) => this.onProgress(event)),
      FileTransfer.onReceiveProgress((event) => this.onProgress(event)),
      FileTransfer.onSendComplete((event) => this.onSendComplete(event)),
      FileTransfer.onReceiveComplete((event) => {
        void this.onReceiveComplete(event);
      }),
      FileTransfer.onError((event) => {
        void this.onNativeError(event);
      }),
    );

    this.sessionUnsubscribes.push(
      SessionManager.onMessage((session, message) => {
        void this.onControl(session, message);
      }),
      SessionManager.onSessionEnd((deviceId) => {
        void this.onSessionLost(deviceId);
      }),
    );
  }

  stop(): void {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    for (const unsubscribe of this.sessionUnsubscribes) unsubscribe();
    this.sessionUnsubscribes = [];
    this.started = false;
  }

  subscribe(listener: TransferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onComplete(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  active(): ActiveTransfer[] {
    return [...this.contexts.values()].map((ctx) => this.snapshot(ctx));
  }

  find(transferId: string): ActiveTransfer | null {
    const ctx = this.contexts.get(transferId);
    return ctx ? this.snapshot(ctx) : null;
  }

  // ---------------------------------------------------------------- sending

  /**
   * Send files to a peer we already have a session with.
   *
   * Hashes every file first (streamed natively), so the offer can carry a
   * digest the receiver will verify against — and so a resume can prove the
   * seam between the old and new bytes is correct.
   */
  async send(
    session: PeerSession,
    selection: SelectedFile[],
    onPrepareProgress?: (done: number, total: number) => void,
  ): Promise<string> {
    if (selection.length === 0) throw new Error('No files selected');

    const transferId = randomId();
    const now = Date.now();
    const offered: OfferedFile[] = [];
    const files: TransferFileRecord[] = [];

    for (let index = 0; index < selection.length; index++) {
      const file = selection[index]!;
      onPrepareProgress?.(index, selection.length);

      const resolved = await FortShareFs.resolveUri(file.uri);
      const size = resolved.size || file.size;
      const sha256 = await FortShareFs.sha256(resolved.path);
      const fileId = randomId();

      offered.push({
        fileId,
        fileIndex: index,
        name: resolved.name || file.name,
        size,
        mimeType: resolved.mimeType || file.mimeType,
        sha256,
      });
      files.push({
        id: fileId,
        transferId,
        fileIndex: index,
        name: resolved.name || file.name,
        uri: resolved.path,
        destPath: null,
        size,
        mimeType: resolved.mimeType || file.mimeType,
        sha256,
        transferredBytes: 0,
        status: 'pending',
        verified: null,
        error: null,
        skipReason: null,
      });
    }
    onPrepareProgress?.(selection.length, selection.length);

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const record: TransferRecord = {
      id: transferId,
      deviceId: session.peer.deviceId,
      deviceName: session.peer.deviceName,
      direction: 'send',
      status: 'awaiting-approval',
      createdAt: now,
      completedAt: null,
      totalBytes,
      transferredBytes: 0,
      fileCount: files.length,
      avgSpeed: 0,
      durationMs: 0,
      pauseReason: null,
      errorReason: null,
    };

    // Persisted before the first byte moves, so an interruption at any point
    // from here on is recoverable.
    await transferRepository.create(record, files);

    const ctx: TransferContext = {
      record,
      files,
      session,
      speed: new SpeedTracker(),
      currentFileIndex: 0,
      filesCompleted: 0,
      filesFailed: 0,
      stopping: null,
      waiters: new Map(),
      lastAck: new Map(),
    };
    this.contexts.set(transferId, ctx);
    this.emit(ctx);

    await SessionManager.send(session.peer.deviceId, {
      t: 'TRANSFER_OFFER',
      transferId,
      sessionToken: session.peerSessionToken,
      files: offered,
      totalBytes,
    });

    return transferId;
  }

  /** Run the send loop once the peer has accepted. */
  private async runSend(
    ctx: TransferContext,
    accepted: AcceptedFile[],
  ): Promise<void> {
    const session = ctx.session;
    if (!session) return;

    const byId = new Map(accepted.map((file) => [file.fileId, file]));
    await this.setStatus(ctx, 'active');
    ctx.speed.start(ctx.record.transferredBytes);

    for (const file of ctx.files) {
      if (ctx.stopping) return;

      const decision = byId.get(file.id);
      if (!decision || decision.resolution === 'skip') {
        file.status = 'skipped';
        await transferRepository.updateFile(file.id, { status: 'skipped' });
        continue;
      }
      if (file.status === 'completed') continue;

      const offset = Math.min(Math.max(decision.startOffset, 0), file.size);
      file.transferredBytes = offset;
      file.status = 'active';
      ctx.currentFileIndex = file.fileIndex;
      await transferRepository.updateFile(file.id, {
        status: 'active',
        transferredBytes: offset,
      });
      this.emit(ctx);

      // Already complete on the peer — nothing to stream, just confirm.
      if (offset >= file.size) {
        await this.finishSentFile(ctx, file);
        continue;
      }

      await SessionManager.send(session.peer.deviceId, {
        t: 'FILE_BEGIN',
        transferId: ctx.record.id,
        fileId: file.id,
        fileIndex: file.fileIndex,
        offset,
        size: file.size,
      });

      if (!file.uri) {
        await this.failFile(ctx, file, 'source file is no longer available');
        continue;
      }

      // Registered *before* the send so there is no window in which the peer
      // could settle the file before we are listening for it. Awaiting the
      // send first would work today only because native events arrive on a
      // later macrotask — too subtle a thing to depend on.
      const handoff = this.awaitFileHandoff(ctx, file.id);

      try {
        // Returns as soon as native has queued the stream; the actual bytes
        // move on a native background thread with the socket write providing
        // backpressure. Completion arrives as onSendComplete.
        await FileTransfer.send(session.connectionId, {
          transferId: ctx.record.id,
          fileId: file.id,
          fileIndex: file.fileIndex,
          uri: file.uri,
          offset,
          size: file.size,
        });
        await handoff;
      } catch (error) {
        // Release the waiter we registered, or the loop would never advance.
        this.releaseWaiter(ctx, `file:${file.id}`);
        if (ctx.stopping) return;
        await this.failFile(
          ctx,
          file,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (!ctx.stopping) await this.completeTransfer(ctx);
  }

  /**
   * Block until this file is either verified by the peer or fails.
   *
   * The sender waits for FILE_VERIFIED rather than assuming success once the
   * last byte is written: a digest mismatch has to fail the file, and the
   * receiver is the only party that can compute the digest of what it stored.
   */
  private awaitFileHandoff(ctx: TransferContext, fileId: string): Promise<void> {
    // Already settled (a skipped file, or a race we lost): do not wait.
    const file = ctx.files.find((candidate) => candidate.id === fileId);
    if (
      file &&
      (file.status === 'completed' ||
        file.status === 'failed' ||
        file.status === 'skipped')
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      ctx.waiters.set(`file:${fileId}`, () => resolve());
    });
  }

  private releaseWaiter(ctx: TransferContext, key: string): void {
    const waiter = ctx.waiters.get(key);
    if (!waiter) return;
    ctx.waiters.delete(key);
    waiter();
  }

  // -------------------------------------------------------------- receiving

  /**
   * Handle an incoming offer: authorise it, resolve duplicates, arm the
   * receivers, and only then accept.
   *
   * Every receiver is armed *before* TRANSFER_ACCEPT goes out, so there is no
   * window in which the peer could stream a chunk we are not ready to store.
   */
  private async onOffer(
    session: PeerSession,
    offer: TransferOfferMessage,
  ): Promise<void> {
    /**
     * Same offer twice: ignore it.
     *
     * Defence in depth against a duplicated listener or a peer that retries.
     * Rejecting the second copy would tell the sender the transfer was
     * declined while the receiver still has the prompt open — which is
     * exactly the failure this guard exists to make impossible.
     */
    if (this.contexts.has(offer.transferId)) {
      log.warn('ignoring duplicate offer', { transferId: offer.transferId });
      return;
    }

    if (offer.sessionToken !== session.sessionToken) {
      await SessionManager.send(session.peer.deviceId, {
        t: 'TRANSFER_REJECT',
        transferId: offer.transferId,
        reason: 'invalid or expired session credential',
      });
      return;
    }

    const approval = await this.approveTransfer(session, offer);
    if (!approval.accepted) {
      log.info(`offer refused: ${approval.reason}`, {
        transferId: offer.transferId,
      });
      await SessionManager.send(session.peer.deviceId, {
        t: 'TRANSFER_REJECT',
        transferId: offer.transferId,
        reason: approval.reason,
      });
      return;
    }

    const dir = await FortShareFs.receivedDir();
    const now = Date.now();
    const files: TransferFileRecord[] = [];
    const accepted: AcceptedFile[] = [];

    for (const offeredFile of offer.files) {
      let resolution: DuplicateResolution = 'keep-both';
      let destPath = `${dir}/${offeredFile.name}`;
      let skipReason: TransferFileRecord['skipReason'] = null;

      /**
       * Content-addressed duplicate check.
       *
       * Every offered file arrives with a SHA-256 already computed, so an
       * incoming file can be matched against what has previously been
       * received *by content* — catching a duplicate even when it has been
       * renamed, which filename comparison misses. Re-sending a folder of
       * photos then costs nothing for the ones already on the device.
       *
       * Only trusted if the matched file is still on disk: a history row for
       * a file the user has since deleted must not cause a silent skip.
       */
      const known = await transferRepository
        .findReceivedByDigest(offeredFile.sha256)
        .catch(() => null);

      if (known && (await FortShareFs.exists(known.destPath).catch(() => false))) {
        resolution = 'skip';
        skipReason = 'already-have';
        destPath = known.destPath;
      } else if (await FortShareFs.exists(destPath)) {
        resolution = await this.resolveDuplicate(offeredFile.name, offeredFile.size);
        if (resolution === 'keep-both') {
          destPath = await FortShareFs.uniquePath(dir, offeredFile.name);
        }
        if (resolution === 'skip') skipReason = 'user-choice';
      } else {
        resolution = 'replace';
      }

      const record: TransferFileRecord = {
        id: offeredFile.fileId,
        transferId: offer.transferId,
        fileIndex: offeredFile.fileIndex,
        name: destPath.split('/').pop() ?? offeredFile.name,
        uri: null,
        destPath,
        size: offeredFile.size,
        mimeType: offeredFile.mimeType,
        sha256: offeredFile.sha256,
        transferredBytes: 0,
        status: resolution === 'skip' ? 'skipped' : 'pending',
        verified: null,
        error: null,
        skipReason,
      };
      files.push(record);

      if (resolution === 'skip') {
        accepted.push({
          fileId: offeredFile.fileId,
          startOffset: offeredFile.size,
          resolution: 'skip',
        });
        continue;
      }

      // Resume if a partial from an earlier attempt is still on disk.
      const partPath = `${destPath}${PART_SUFFIX}`;
      const part = await FortShareFs.stat(partPath);
      const startOffset =
        part.exists && part.size <= offeredFile.size ? part.size : 0;
      record.transferredBytes = startOffset;

      await FileTransfer.receive(session.connectionId, {
        transferId: offer.transferId,
        fileId: offeredFile.fileId,
        fileIndex: offeredFile.fileIndex,
        destPath: partPath,
        offset: startOffset,
        size: offeredFile.size,
      });

      accepted.push({
        fileId: offeredFile.fileId,
        startOffset,
        resolution,
      });
    }

    const transferred = files.reduce(
      (sum, file) => sum + file.transferredBytes,
      0,
    );
    const record: TransferRecord = {
      id: offer.transferId,
      deviceId: session.peer.deviceId,
      deviceName: session.peer.deviceName,
      direction: 'receive',
      status: 'active',
      createdAt: now,
      completedAt: null,
      totalBytes: offer.totalBytes,
      transferredBytes: transferred,
      fileCount: files.length,
      avgSpeed: 0,
      durationMs: 0,
      pauseReason: null,
      errorReason: null,
    };
    await transferRepository.create(record, files);

    const ctx: TransferContext = {
      record,
      files,
      session,
      speed: new SpeedTracker(),
      currentFileIndex: files[0]?.fileIndex ?? 0,
      filesCompleted: 0,
      filesFailed: 0,
      stopping: null,
      waiters: new Map(),
      lastAck: new Map(),
    };
    ctx.speed.start(transferred);
    this.contexts.set(offer.transferId, ctx);
    this.emit(ctx);

    const deduped = files.filter((file) => file.skipReason === 'already-have');
    if (deduped.length > 0) {
      const saved = deduped.reduce((sum, file) => sum + file.size, 0);
      log.info(
        `skipping ${deduped.length} file(s) already on this device — ${saved} bytes not transferred`,
        { names: deduped.map((file) => file.name) },
      );
    }

    await SessionManager.send(session.peer.deviceId, {
      t: 'TRANSFER_ACCEPT',
      transferId: offer.transferId,
      files: accepted,
    });
  }

  /**
   * A file finished arriving. Verify it, then publish it.
   *
   * The digest is computed over the whole reassembled file, which is what
   * proves a resumed transfer joined correctly at the seam (§19). The `.part`
   * file is only renamed into place once it matches.
   */
  private async onReceiveComplete(event: ReceiveCompleteEvent): Promise<void> {
    const ctx = this.contexts.get(event.transferId);
    if (!ctx) return;
    const file = ctx.files.find((candidate) => candidate.id === event.fileId);
    if (!file || !file.destPath) return;
    if (file.status === 'completed') return;

    const partPath = event.path;
    let computed = '';
    try {
      computed = await FortShareFs.sha256(partPath);
    } catch (error) {
      await this.failFile(
        ctx,
        file,
        error instanceof Error ? error.message : 'could not hash received file',
      );
      await this.reportVerification(ctx, file.id, false, '');
      return;
    }

    const expected = file.sha256 ?? '';
    const ok = expected.length > 0 && digestsMatch(computed, expected);

    if (!ok) {
      // Keep the .part file: the user can retry, and discarding evidence of a
      // corrupt transfer helps nobody.
      await this.failFile(ctx, file, 'integrity check failed');
      await this.reportVerification(ctx, file.id, false, computed);
      return;
    }

    await FortShareFs.rename(partPath, file.destPath);
    await FortShareFs.scanMedia(file.destPath, file.mimeType).catch(
      () => undefined,
    );

    file.status = 'completed';
    file.verified = true;
    file.transferredBytes = file.size;
    ctx.filesCompleted += 1;
    await transferRepository.updateFile(file.id, {
      status: 'completed',
      verified: true,
      transferredBytes: file.size,
    });

    await this.reportVerification(ctx, file.id, true, computed);
    this.emit(ctx);

    if (this.allFilesSettled(ctx)) await this.completeTransfer(ctx);
  }

  private async reportVerification(
    ctx: TransferContext,
    fileId: string,
    ok: boolean,
    sha256: string,
  ): Promise<void> {
    const session = ctx.session;
    if (!session) return;
    await SessionManager.send(session.peer.deviceId, {
      t: 'FILE_VERIFIED',
      transferId: ctx.record.id,
      fileId,
      ok,
      sha256,
    }).catch(() => undefined);
  }

  // ----------------------------------------------------------- control plane

  private async onControl(
    session: PeerSession,
    message: ControlMessage,
  ): Promise<void> {
    switch (message.t) {
      case 'TRANSFER_OFFER':
        await this.onOffer(session, message);
        return;

      case 'TRANSFER_ACCEPT': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx || ctx.record.direction !== 'send') return;
        ctx.session = session;
        await this.runSend(ctx, message.files);
        return;
      }

      case 'TRANSFER_REJECT': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        await this.abort(ctx, 'failed', message.reason);
        return;
      }

      case 'FILE_BEGIN': {
        // Informational on the receiver: the receivers are already armed, so
        // this only tells the UI which file is currently streaming.
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        ctx.currentFileIndex = message.fileIndex;
        const file = ctx.files.find((candidate) => candidate.id === message.fileId);
        if (file && file.status === 'pending') {
          file.status = 'active';
          await transferRepository.updateFile(file.id, { status: 'active' });
        }
        this.emit(ctx);
        return;
      }

      case 'CHUNK_ACK': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        const file = ctx.files.find((candidate) => candidate.id === message.fileId);
        if (!file) return;
        // Advisory only: resume never trusts this, it re-reads the receiver's
        // on-disk length. Here it just keeps the sender's UI honest.
        file.transferredBytes = Math.max(file.transferredBytes, message.receivedBytes);
        this.recomputeProgress(ctx);
        this.emit(ctx);
        return;
      }

      case 'FILE_END':
        // The receiver verifies against the digest from the offer; this is a
        // redundant end marker kept for protocol clarity.
        return;

      case 'FILE_VERIFIED': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx || ctx.record.direction !== 'send') return;
        const file = ctx.files.find((candidate) => candidate.id === message.fileId);
        if (!file) return;

        if (message.ok) {
          await this.finishSentFile(ctx, file);
        } else {
          await this.failFile(
            ctx,
            file,
            'the other device reported an integrity mismatch',
          );
        }
        this.releaseWaiter(ctx, `file:${file.id}`);
        return;
      }

      case 'TRANSFER_DONE': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        if (this.allFilesSettled(ctx)) await this.completeTransfer(ctx);
        return;
      }

      case 'TRANSFER_PAUSE': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        await this.pauseLocal(ctx, 'peer');
        return;
      }

      case 'TRANSFER_RESUME':
        await this.onResumeRequest(session, message.transferId, message.sessionToken);
        return;

      case 'RESUME_STATE': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        await this.onResumeState(ctx, message);
        return;
      }

      case 'TRANSFER_CANCEL': {
        const ctx = this.contexts.get(message.transferId);
        if (!ctx) return;
        await this.abort(ctx, 'cancelled', 'cancelled by the other device');
        return;
      }

      default:
        return;
    }
  }

  // ------------------------------------------------------------------ resume

  /**
   * The peer wants to resume. Answer with what we actually have on disk.
   *
   * The lengths reported here come from `stat` on each `.part` file, not from
   * a counter — the receiver's disk is the only thing that knows which bytes
   * survived the drop.
   */
  private async onResumeRequest(
    session: PeerSession,
    transferId: string,
    sessionToken: string,
  ): Promise<void> {
    if (sessionToken !== session.sessionToken) {
      await SessionManager.send(session.peer.deviceId, {
        t: 'RESUME_STATE',
        transferId,
        files: [],
        known: false,
      });
      return;
    }

    const record = await transferRepository.find(transferId);
    if (!record || record.direction !== 'receive') {
      await SessionManager.send(session.peer.deviceId, {
        t: 'RESUME_STATE',
        transferId,
        files: [],
        known: false,
      });
      return;
    }

    const files = await transferRepository.files(transferId);
    const state: ResumeStateMessage['files'] = [];

    for (const file of files) {
      if (!file.destPath || file.status === 'skipped') {
        state.push({ fileId: file.id, receivedBytes: file.size });
        continue;
      }
      if (file.status === 'completed') {
        state.push({ fileId: file.id, receivedBytes: file.size });
        continue;
      }

      const partPath = `${file.destPath}${PART_SUFFIX}`;
      const part = await FortShareFs.stat(partPath);
      const receivedBytes =
        part.exists && part.size <= file.size ? part.size : 0;
      state.push({ fileId: file.id, receivedBytes });

      // Re-arm the receiver at the resumed offset before answering.
      await FileTransfer.receive(session.connectionId, {
        transferId,
        fileId: file.id,
        fileIndex: file.fileIndex,
        destPath: partPath,
        offset: receivedBytes,
        size: file.size,
      });
    }

    // Rebuild the live context so progress reporting works after a restart.
    let ctx = this.contexts.get(transferId);
    if (!ctx) {
      ctx = {
        record: { ...record, status: 'active', pauseReason: null },
        files,
        session,
        speed: new SpeedTracker(),
        currentFileIndex: files[0]?.fileIndex ?? 0,
        filesCompleted: files.filter((file) => file.status === 'completed').length,
        filesFailed: 0,
        stopping: null,
        waiters: new Map(),
        lastAck: new Map(),
      };
      this.contexts.set(transferId, ctx);
    }
    ctx.session = session;
    ctx.stopping = null;
    for (const file of ctx.files) {
      const resumed = state.find((entry) => entry.fileId === file.id);
      if (resumed) file.transferredBytes = resumed.receivedBytes;
    }
    this.recomputeProgress(ctx);
    ctx.speed.resumeFrom(ctx.record.transferredBytes);
    await this.setStatus(ctx, 'active');
    await transferRepository.clearFailureState(transferId);

    await SessionManager.send(session.peer.deviceId, {
      t: 'RESUME_STATE',
      transferId,
      files: state,
      known: true,
    });
  }

  /** We asked to resume; the receiver told us where it got to. */
  private async onResumeState(
    ctx: TransferContext,
    message: ResumeStateMessage,
  ): Promise<void> {
    if (!message.known) {
      await this.abort(
        ctx,
        'failed',
        'the other device no longer has this transfer',
      );
      return;
    }

    const accepted: AcceptedFile[] = ctx.files.map((file) => {
      const state = message.files.find((entry) => entry.fileId === file.id);
      const receivedBytes = state?.receivedBytes ?? 0;
      file.transferredBytes = Math.min(receivedBytes, file.size);
      if (receivedBytes >= file.size) {
        file.status = file.status === 'skipped' ? 'skipped' : 'completed';
      }
      return {
        fileId: file.id,
        startOffset: file.transferredBytes,
        resolution: 'replace' as DuplicateResolution,
      };
    });

    this.recomputeProgress(ctx);
    ctx.speed.resumeFrom(ctx.record.transferredBytes);
    ctx.stopping = null;
    await transferRepository.clearFailureState(ctx.record.id);
    await this.runSend(ctx, accepted);
  }

  /**
   * Resume an interrupted transfer (§19).
   *
   * Reconnects if needed — a resume days later, on a different IP, works
   * because the peer is addressed by deviceId and rediscovered.
   */
  async resume(transferId: string): Promise<void> {
    let ctx = this.contexts.get(transferId);
    let record = ctx?.record ?? (await transferRepository.find(transferId));
    if (!record) throw new Error('Transfer not found');

    const session = SessionManager.session(record.deviceId);
    if (!session) {
      throw new Error(`${record.deviceName} is not reachable right now`);
    }

    if (!ctx) {
      const files = await transferRepository.files(transferId);
      ctx = {
        record,
        files,
        session,
        speed: new SpeedTracker(),
        currentFileIndex: files[0]?.fileIndex ?? 0,
        filesCompleted: files.filter((file) => file.status === 'completed').length,
        filesFailed: 0,
        stopping: null,
        waiters: new Map(),
        lastAck: new Map(),
      };
      this.contexts.set(transferId, ctx);
    }
    ctx.session = session;
    ctx.stopping = null;
    record = ctx.record;

    if (record.direction === 'receive') {
      // The receiver cannot pull; it waits for the sender to resume. Mark it
      // active so the UI stops showing a stale paused state.
      await this.setStatus(ctx, 'active');
      return;
    }

    await this.setStatus(ctx, 'active');
    await SessionManager.send(record.deviceId, {
      t: 'TRANSFER_RESUME',
      transferId,
      sessionToken: session.peerSessionToken,
    });
  }

  // ------------------------------------------------------------ pause/cancel

  async pause(transferId: string): Promise<void> {
    const ctx = this.contexts.get(transferId);
    if (!ctx) return;
    const session = ctx.session;
    if (session) {
      await SessionManager.send(session.peer.deviceId, {
        t: 'TRANSFER_PAUSE',
        transferId,
        reason: 'user',
      }).catch(() => undefined);
    }
    await this.pauseLocal(ctx, 'user');
  }

  private async pauseLocal(
    ctx: TransferContext,
    reason: TransferPauseReason,
  ): Promise<void> {
    ctx.stopping = reason;
    const session = ctx.session;
    if (session) {
      await FileTransfer.pause(session.connectionId, ctx.record.id).catch(
        () => undefined,
      );
    }
    for (const key of [...ctx.waiters.keys()]) this.releaseWaiter(ctx, key);
    await this.setStatus(ctx, 'paused', { pauseReason: reason });
  }

  async cancel(transferId: string): Promise<void> {
    const ctx = this.contexts.get(transferId);
    if (!ctx) {
      await transferRepository.updateStatus(transferId, 'cancelled');
      return;
    }
    const session = ctx.session;
    if (session) {
      await SessionManager.send(session.peer.deviceId, {
        t: 'TRANSFER_CANCEL',
        transferId,
      }).catch(() => undefined);
      await FileTransfer.cancel(session.connectionId, transferId).catch(
        () => undefined,
      );
    }
    await this.abort(ctx, 'cancelled', null);
  }

  // ------------------------------------------------------------ native events

  private onProgress(event: TransferProgressEvent): void {
    const ctx = this.contexts.get(event.transferId);
    if (!ctx) return;
    const file = ctx.files.find((candidate) => candidate.id === event.fileId);
    if (!file) return;

    file.transferredBytes = event.transferredBytes;
    ctx.currentFileIndex = event.fileIndex;
    this.recomputeProgress(ctx);
    ctx.speed.update(ctx.record.transferredBytes);
    this.emit(ctx);

    if (ctx.record.direction === 'receive') this.maybeAck(ctx, file);

    // Persist coarsely: a row write per progress tick would be pointless I/O,
    // and resume re-derives offsets from disk anyway.
    void transferRepository
      .updateFileProgress(file.id, file.transferredBytes)
      .catch(() => undefined);
  }

  /**
   * Tell the sender how many bytes actually reached our disk (§18).
   *
   * Rate-limited to one message per ACK_INTERVAL_BYTES, because this is a UI
   * courtesy rather than flow control: the sender's own socket writes already
   * give it a progress figure, and the TCP window is what regulates pace.
   * What this adds is the *landed* count, which is strictly behind the sent
   * count and therefore the honest number to show.
   */
  private maybeAck(ctx: TransferContext, file: TransferFileRecord): void {
    const session = ctx.session;
    if (!session) return;

    const lastAcked = ctx.lastAck.get(file.id) ?? 0;
    const complete = file.transferredBytes >= file.size;
    if (!complete && file.transferredBytes - lastAcked < ACK_INTERVAL_BYTES) return;

    ctx.lastAck.set(file.id, file.transferredBytes);
    void SessionManager.send(session.peer.deviceId, {
      t: 'CHUNK_ACK',
      transferId: ctx.record.id,
      fileId: file.id,
      receivedBytes: file.transferredBytes,
    }).catch(() => undefined);
  }

  private onSendComplete(event: SendCompleteEvent): void {
    const ctx = this.contexts.get(event.transferId);
    if (!ctx) return;
    const file = ctx.files.find((candidate) => candidate.id === event.fileId);
    if (!file || !ctx.session) return;

    file.transferredBytes = event.transferredBytes;
    this.recomputeProgress(ctx);
    this.emit(ctx);

    // All bytes are out; declare the digest and let the receiver verify.
    void SessionManager.send(ctx.session.peer.deviceId, {
      t: 'FILE_END',
      transferId: ctx.record.id,
      fileId: file.id,
      sha256: file.sha256 ?? '',
    }).catch(() => undefined);
  }

  private async onNativeError(event: TransferErrorEvent): Promise<void> {
    const ctx = this.contexts.get(event.transferId);
    if (!ctx) return;

    if (event.recoverable) {
      // A dropped socket, not a bad file: keep the partial state and let the
      // user resume when the device is reachable again (§38).
      await this.pauseLocal(ctx, 'network-lost');
      return;
    }

    if (event.fileId) {
      const file = ctx.files.find((candidate) => candidate.id === event.fileId);
      if (file) {
        await this.failFile(ctx, file, event.message);
        this.releaseWaiter(ctx, `file:${file.id}`);
        return;
      }
    }
    await this.abort(ctx, 'failed', event.message);
  }

  /** The session died. Every transfer on it becomes resumable, not failed. */
  private async onSessionLost(deviceId: string): Promise<void> {
    for (const ctx of this.contexts.values()) {
      if (ctx.record.deviceId !== deviceId) continue;
      if (ctx.record.status === 'completed' || ctx.record.status === 'cancelled') {
        continue;
      }
      ctx.session = null;
      await this.pauseLocal(ctx, 'peer-unreachable');
    }
  }

  // ----------------------------------------------------------------- helpers

  private async finishSentFile(
    ctx: TransferContext,
    file: TransferFileRecord,
  ): Promise<void> {
    if (file.status === 'completed') return;
    file.status = 'completed';
    file.verified = true;
    file.transferredBytes = file.size;
    ctx.filesCompleted += 1;
    this.recomputeProgress(ctx);
    await transferRepository.updateFile(file.id, {
      status: 'completed',
      verified: true,
      transferredBytes: file.size,
    });
    this.emit(ctx);
  }

  private async failFile(
    ctx: TransferContext,
    file: TransferFileRecord,
    reason: string,
  ): Promise<void> {
    file.status = 'failed';
    file.verified = false;
    file.error = reason;
    ctx.filesFailed += 1;
    await transferRepository.updateFile(file.id, {
      status: 'failed',
      verified: false,
      error: reason,
    });
    this.emit(ctx);
  }

  private allFilesSettled(ctx: TransferContext): boolean {
    return ctx.files.every(
      (file) =>
        file.status === 'completed' ||
        file.status === 'failed' ||
        file.status === 'skipped',
    );
  }

  private async completeTransfer(ctx: TransferContext): Promise<void> {
    if (ctx.record.status === 'completed') return;

    const failed = ctx.files.filter((file) => file.status === 'failed').length;
    const completedFiles = ctx.files.filter(
      (file) => file.status === 'completed',
    );
    const bytes = completedFiles.reduce((sum, file) => sum + file.size, 0);
    const durationMs = ctx.speed.elapsedMs;
    const avgSpeed = ctx.speed.average(ctx.record.transferredBytes);

    ctx.record = {
      ...ctx.record,
      status: failed > 0 && completedFiles.length === 0 ? 'failed' : 'completed',
      completedAt: Date.now(),
      durationMs,
      avgSpeed,
    };

    await transferRepository.updateStatus(ctx.record.id, ctx.record.status, {
      completedAt: ctx.record.completedAt,
      durationMs,
      avgSpeed,
    });
    await transferRepository.updateProgress(
      ctx.record.id,
      ctx.record.transferredBytes,
    );

    // Fold into the device's running totals (§28).
    await deviceRepository
      .addTransferStats(
        ctx.record.deviceId,
        ctx.record.direction,
        completedFiles.length,
        bytes,
      )
      .catch(() => undefined);

    if (ctx.session) {
      await SessionManager.send(ctx.session.peer.deviceId, {
        t: 'TRANSFER_DONE',
        transferId: ctx.record.id,
        filesCompleted: completedFiles.length,
        filesFailed: failed,
      }).catch(() => undefined);
    }

    this.emit(ctx);
    for (const listener of this.completionListeners) listener(ctx.record);
    this.contexts.delete(ctx.record.id);
  }

  private async abort(
    ctx: TransferContext,
    status: 'failed' | 'cancelled',
    reason: string | null,
  ): Promise<void> {
    ctx.stopping = status === 'cancelled' ? 'user' : 'error';
    for (const key of [...ctx.waiters.keys()]) this.releaseWaiter(ctx, key);
    ctx.record = {
      ...ctx.record,
      status,
      errorReason: reason,
      completedAt: Date.now(),
    };
    await transferRepository.updateStatus(ctx.record.id, status, {
      errorReason: reason,
      completedAt: ctx.record.completedAt,
    });
    this.emit(ctx);
    for (const listener of this.completionListeners) listener(ctx.record);
    this.contexts.delete(ctx.record.id);
  }

  private async setStatus(
    ctx: TransferContext,
    status: TransferRecord['status'],
    extra: { pauseReason?: TransferPauseReason | null } = {},
  ): Promise<void> {
    ctx.record = {
      ...ctx.record,
      status,
      pauseReason: extra.pauseReason ?? ctx.record.pauseReason,
    };
    await transferRepository.updateStatus(ctx.record.id, status, extra);
    this.emit(ctx);
  }

  private recomputeProgress(ctx: TransferContext): void {
    const transferred = ctx.files.reduce(
      (sum, file) => sum + Math.min(file.transferredBytes, file.size),
      0,
    );
    ctx.record = { ...ctx.record, transferredBytes: transferred };
  }

  private snapshot(ctx: TransferContext): ActiveTransfer {
    return {
      record: ctx.record,
      files: ctx.files.map((file) => ({ ...file })),
      currentFileIndex: ctx.currentFileIndex,
      speed: ctx.speed.current,
      etaSeconds: ctx.speed.eta(
        ctx.record.transferredBytes,
        ctx.record.totalBytes,
      ),
      filesCompleted: ctx.filesCompleted,
    };
  }

  private emit(ctx: TransferContext): void {
    const snapshot = this.snapshot(ctx);
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const TransferEngine = new TransferEngineImpl();
