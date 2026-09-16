import { AppState as RNAppState, type AppStateStatus } from 'react-native';
import { initDatabase } from '../database';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { SessionManager } from '../network/session/SessionManager';
import { TransferEngine } from '../network/transfer/TransferEngine';
import { Notifications } from '../native';
import {
  useAppStore,
  useDeviceStore,
  useTransferStore,
  useUiStore,
} from '../store';
import { loadIdentity } from './identity';
import { evaluateTrust } from '../network/pairing/trust';
import { transferRepository } from '../database/repositories';
import {
  initialiseAds,
  maybeShowInterstitial,
  noteTransferCompleted,
} from './ads';
import type { HandshakePeer } from '../network/pairing/handshake';
import type { PeerSession } from '../network/session/SessionManager';
import type { TransferOfferMessage } from '../models/protocol';
import type { ApprovalResult } from '../network/transfer/TransferEngine';
import type { ActiveTransfer } from '../models/transfer';
import type { DiscoveredPeer } from '../models/device';
import { formatBytes, percentOf } from '../utils/format';
import { DeviceDiscovery } from '../native';
import { logger } from './log';

const log = logger('boot');

/**
 * Wires the app together, in the one order that works (§48 phases 3-9):
 *
 *   database  →  identity  →  TCP listener  →  advertise + browse
 *
 * The listener must bind before discovery starts, because the port it binds is
 * what goes into the mDNS TXT record. Identity must exist before either,
 * because the deviceId is what we advertise and the keys are what prove it.
 *
 * Nothing here contacts a network service: every step is local.
 */

let started = false;
let unsubscribers: (() => void)[] = [];
let appStateSubscription: { remove: () => void } | null = null;
/**
 * The transfer that currently owns the Android foreground service.
 *
 * Android will freeze a backgrounded process and tear down its sockets, so a
 * foreground service is the only sanctioned way to keep a transfer running.
 * Previously it was started incidentally by the first progress update, which
 * meant a transfer whose notifications were disabled — or which finished its
 * first chunk before the throttle fired — had no service at all and was
 * killed the moment the user switched apps.
 */
let serviceOwner: string | null = null;

export async function startFortShare(): Promise<void> {
  if (started) return;
  started = true;

  const app = useAppStore.getState();

  try {
    await initDatabase();

    const identity = await loadIdentity();
    app.setIdentity(identity);

    await useDeviceStore.getState().refreshHistory();
    await Promise.all([
      useTransferStore.getState().refreshHistory(),
      useTransferStore.getState().refreshReceived(),
    ]);
    void app.refreshStorage();

    wireStoreBridges();

    // Listener first: discovery advertises the port it returns.
    const port = await SessionManager.start(identity, (peer) =>
      handlePairingRequest(peer),
    );
    app.setPort(port);

    TransferEngine.start({
      approveTransfer: (session, offer) => handleTransferOffer(session, offer),
      resolveDuplicate: (fileName, size) =>
        useUiStore.getState().requestDuplicateResolution(fileName, size),
    });

    await DiscoveryService.start(identity, port);

    // Logged once at startup because almost every "cannot connect" report
    // comes down to which interface the device is advertising. Having this in
    // the log makes the next such report answerable without guessing.
    void DeviceDiscovery.getNetworkInfo()
      .then((info) => {
        log.info(`advertising on ${info.primary || '(no address)'}:${port}`, {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          interfaces: info.addresses.map(
            (entry) => `${entry.interfaceName}=${entry.address} (${entry.kind})`,
          ),
        });
        if (!info.primary) {
          log.warn(
            'no usable local address — peers will not be able to reach this device',
          );
        }
      })
      .catch((error: unknown) => log.warn('could not read network info', error));

    // Anything still marked active was interrupted by the process dying, so
    // reconcile it before the UI renders a transfer that is not running.
    await reconcileInterruptedTransfers();

    watchAppState();
    app.setPhase('ready');

    /**
     * Ads start last, and un-awaited.
     *
     * Initialisation does network I/O. Putting it anywhere before this point
     * would let a slow or blocked ad server delay the listener binding, the
     * first render, or discovery — none of which have any business waiting on
     * an advert.
     */
    void initialiseAds();
  } catch (error) {
    started = false;
    app.setPhase(
      'failed',
      error instanceof Error ? error.message : 'FortShare could not start',
    );
  }
}

export async function stopFortShare(): Promise<void> {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  appStateSubscription?.remove();
  appStateSubscription = null;

  TransferEngine.stop();
  await DiscoveryService.stop().catch(() => undefined);
  await SessionManager.stop().catch(() => undefined);
  await Notifications.stop().catch(() => undefined);
  started = false;
}

/** Re-advertise after a rename, without disturbing the deviceId. */
export async function republishIdentity(): Promise<void> {
  const identity = useAppStore.getState().identity;
  if (!identity) return;
  SessionManager.updateIdentity(identity);
  await DiscoveryService.republish(identity).catch(() => undefined);
}

// -------------------------------------------------------------- store bridges

function wireStoreBridges(): void {
  // Discovery → device store.
  unsubscribers.push(
    DiscoveryService.subscribe((state) => {
      useDeviceStore.getState().applyDiscovery(state);
      void maybeAutoResume(state.peers);
    }),
  );

  // A successful handshake writes history; reload so the row appears at once.
  unsubscribers.push(
    SessionManager.onSession((session) => {
      void useDeviceStore.getState().refreshHistory();
      useDeviceStore.getState().setConnecting(session.peer.deviceId, false);
      // Marks the device reachable even if it never announced itself over
      // mDNS — which is exactly what a QR pairing produces.
      useDeviceStore.getState().setConnected(session.peer.deviceId, true);
    }),
  );

  unsubscribers.push(
    SessionManager.onSessionEnd((deviceId, reason) => {
      useDeviceStore.getState().setConnecting(deviceId, false);
      useDeviceStore.getState().setConnected(deviceId, false);
      // A prompt whose peer has gone must be retired, or it blocks every
      // later request: a pending prompt causes the next offer to be refused.
      useUiStore
        .getState()
        .cancelPromptsForDevice(
          deviceId,
          `the connection was lost (${reason})`,
        );
    }),
  );

  // Transfer engine → transfer store, plus the notification mirror.
  unsubscribers.push(
    TransferEngine.subscribe((transfer) => {
      useTransferStore.getState().applyActive(transfer);
      void keepAliveForTransfer(transfer);
      void mirrorToNotification(transfer);
    }),
  );

  unsubscribers.push(
    TransferEngine.onComplete((record) => {
      void useDeviceStore.getState().refreshHistory();
      void useAppStore.getState().refreshStorage();
      // Release the foreground service: holding it after the work is done is
      // both a battery cost and a permanent notification the user cannot
      // dismiss.
      if (serviceOwner === record.id) serviceOwner = null;
      void Notifications.stop().catch(() => undefined);

      const store = useUiStore.getState();
      noteTransferCompleted();

      /**
       * A finished transfer is the one genuinely natural break in this app —
       * the user has got what they came for and is not mid-task. Suppressed
       * while anything else is still running, so an ad can never cover a live
       * progress bar.
       */
      maybeShowInterstitial({
        hasActiveTransfer: useTransferStore.getState().active.size > 0,
      });

      if (record.status === 'completed') {
        const verb = record.direction === 'send' ? 'Sent' : 'Received';
        store.toast(
          `${verb} ${record.fileCount} ${record.fileCount === 1 ? 'file' : 'files'} · ${formatBytes(record.transferredBytes)}`,
          'success',
        );
        void notifyQuietly(
          record.id,
          'Transfer complete',
          `${verb} ${record.fileCount} ${record.fileCount === 1 ? 'file' : 'files'} · ${record.deviceName}`,
        );
      } else if (record.status === 'failed') {
        store.toast(record.errorReason ?? 'Transfer failed', 'error');
        void notifyQuietly(
          record.id,
          'Transfer failed',
          record.errorReason ?? `Could not finish with ${record.deviceName}`,
        );
      }
    }),
  );

  // Notification actions (§36): Pause/Cancel from the shade.
  unsubscribers.push(
    (() => {
      const subscription = Notifications.onAction((event) => {
        const store = useTransferStore.getState();
        if (event.action === 'pause') void store.pause(event.transferId);
        if (event.action === 'cancel') void store.cancel(event.transferId);
      });
      return () => subscription.remove();
    })(),
  );
}

// ------------------------------------------------------------------- prompts

/**
 * An unknown device dialled us.
 *
 * Reached only when the handshake found no pinned key and no valid QR proof,
 * so this really is a stranger and the user has to decide (§15).
 */
async function handlePairingRequest(peer: HandshakePeer): Promise<boolean> {
  return useUiStore.getState().requestPairing(peer);
}

/**
 * A peer is offering us files.
 *
 * Auto-accept is opt-in and only ever applies to a device whose key we have
 * pinned — never to a stranger, however friendly its name (§42).
 */
async function handleTransferOffer(
  session: PeerSession,
  offer: TransferOfferMessage,
): Promise<ApprovalResult> {
  const preferences = useAppStore.getState().preferences;

  if (preferences.autoAcceptFromPaired) {
    const decision = await evaluateTrust(
      session.peer.deviceId,
      session.peer.edPub,
    );
    if (decision.kind === 'trusted') {
      useUiStore
        .getState()
        .toast(
          `Receiving ${offer.files.length} ${offer.files.length === 1 ? 'file' : 'files'} from ${session.peer.deviceName}`,
        );
      return { accepted: true };
    }
  }

  return useUiStore.getState().requestTransferApproval(session, offer);
}

/**
 * Recover transfers that were interrupted by the app closing (§19).
 *
 * The bytes already moved are safe: the receiver keeps its `.part` file and
 * every offset is in SQLite. What was missing was the reconciliation — a
 * transfer left marked `active` looked like it was still running, and nothing
 * ever tried to pick it up again.
 *
 * Marked paused here; `maybeAutoResume` then resumes each one as soon as its
 * peer is reachable, which is usually within seconds of discovery starting.
 */
async function reconcileInterruptedTransfers(): Promise<void> {
  const reconciled = await transferRepository
    .markInterruptedAsPaused()
    .catch(() => 0);

  if (reconciled > 0) {
    log.info(
      `${reconciled} transfer(s) were interrupted — marked resumable`,
    );
    await useTransferStore.getState().refreshHistory();

    const resumable = await transferRepository.resumable().catch(() => []);
    if (resumable.length > 0) {
      useUiStore
        .getState()
        .toast(
          `${resumable.length} interrupted transfer${resumable.length === 1 ? '' : 's'} will resume when the device is back`,
        );
    }
  }
}

// ------------------------------------------------------------ auto behaviours

/** deviceIds we have already tried to auto-resume, so we do not loop. */
const autoResumeAttempted = new Set<string>();

/**
 * Resume a paused transfer when its peer reappears (§19, §38).
 *
 * Deliberately conservative: opt-in, only for transfers we were sending (the
 * receiver cannot pull), and only once per peer per appearance.
 */
async function maybeAutoResume(
  peers: Map<string, DiscoveredPeer>,
): Promise<void> {
  if (!useAppStore.getState().preferences.autoResume) return;

  for (const deviceId of autoResumeAttempted) {
    if (!peers.has(deviceId)) autoResumeAttempted.delete(deviceId);
  }

  const paused = useTransferStore
    .getState()
    .history.filter(
      (record) =>
        record.status === 'paused' &&
        // Only the sender can resume: the receiver has nothing to push, it
        // waits for TRANSFER_RESUME and answers with what it already has.
        record.direction === 'send' &&
        peers.has(record.deviceId) &&
        !autoResumeAttempted.has(record.deviceId),
    );

  for (const record of paused) {
    autoResumeAttempted.add(record.deviceId);

    // Establish the session if there isn't one.
    //
    // After an app restart there is never a session yet — discovery finds the
    // peer seconds before anything connects. Requiring an existing session
    // here meant an interrupted transfer was reconciled, shown as resumable,
    // and then silently never resumed.
    if (!SessionManager.isConnected(record.deviceId)) {
      const peer = peers.get(record.deviceId);
      if (!peer) continue;
      try {
        log.info(`reconnecting to ${record.deviceName} to resume a transfer`);
        await SessionManager.connect(peer);
      } catch (error) {
        log.warn(`could not reconnect to ${record.deviceName} to resume`, error);
        continue;
      }
    }

    await useTransferStore
      .getState()
      .resume(record.id)
      .then(() => log.info(`resumed transfer with ${record.deviceName}`))
      .catch((error: unknown) =>
        log.warn(`resume failed for ${record.deviceName}`, error),
      );
  }
}

/**
 * Claim the foreground service for as long as a transfer is running.
 *
 * Started explicitly when a transfer goes active, rather than relying on a
 * progress update to do it as a side effect. Only one transfer needs to own
 * it — the service keeps the whole process alive, not a single stream.
 */
async function keepAliveForTransfer(transfer: ActiveTransfer): Promise<void> {
  const { record } = transfer;
  const running = record.status === 'active' || record.status === 'paused';

  if (!running) {
    if (serviceOwner === record.id) {
      serviceOwner = null;
      await Notifications.stop().catch(() => undefined);
    }
    return;
  }

  if (serviceOwner === record.id) return;
  if (serviceOwner !== null) return; // another transfer already holds it

  serviceOwner = record.id;
  const verb = record.direction === 'send' ? 'Sending to' : 'Receiving from';
  await Notifications.start({
    transferId: record.id,
    title: `${verb} ${record.deviceName}`,
    body: `${record.fileCount} ${record.fileCount === 1 ? 'file' : 'files'}`,
  }).catch(() => undefined);
}

/** Keep the Android foreground-service notification in step with progress. */
async function mirrorToNotification(transfer: ActiveTransfer): Promise<void> {
  if (!useAppStore.getState().preferences.notificationsEnabled) return;
  const { record } = transfer;

  if (record.status !== 'active') {
    if (record.status === 'paused') {
      await Notifications.update({
        transferId: record.id,
        title: 'Transfer paused',
        body: record.deviceName,
        progress: Math.round(
          percentOf(record.transferredBytes, record.totalBytes),
        ),
        indeterminate: false,
      }).catch(() => undefined);
    }
    return;
  }

  const verb = record.direction === 'send' ? 'Sending to' : 'Receiving from';
  await Notifications.update({
    transferId: record.id,
    title: `${verb} ${record.deviceName}`,
    body: `${formatBytes(record.transferredBytes)} of ${formatBytes(record.totalBytes)}`,
    progress: Math.round(percentOf(record.transferredBytes, record.totalBytes)),
    indeterminate: false,
  }).catch(() => undefined);
}

async function notifyQuietly(
  id: string,
  title: string,
  body: string,
): Promise<void> {
  if (!useAppStore.getState().preferences.notificationsEnabled) return;
  await Notifications.notify(id, title, body).catch(() => undefined);
}

// ----------------------------------------------------------------- lifecycle

/**
 * Re-scan when the app comes back to the foreground.
 *
 * While backgrounded the OS may have torn down our mDNS registration, and the
 * network may have changed entirely, so the peer list is assumed stale.
 */
function watchAppState(): void {
  let previous: AppStateStatus = RNAppState.currentState;

  appStateSubscription = RNAppState.addEventListener('change', (next) => {
    const returning = previous !== 'active' && next === 'active';
    previous = next;
    if (!returning) return;

    void DiscoveryService.refresh().catch(() => undefined);
    void useDeviceStore.getState().refreshHistory();
    void useAppStore.getState().refreshStorage();
  });
}
