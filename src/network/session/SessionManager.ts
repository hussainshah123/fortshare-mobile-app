import type { EventSubscription } from 'react-native';
import { PeerConnection } from '../../native';
import type { ConnectionEvent, ControlEvent, DisconnectEvent } from '../../native';
import type { ControlMessage } from '../../models/protocol';
import { CIPHER_NONE, type CipherSuite } from '../../constants/protocol';
import type { DiscoveredPeer, LocalIdentity } from '../../models/device';
import { deviceRepository } from '../../database/repositories';
import { identitySecrets } from '../../services/identity';
import { Handshake, HandshakeError } from '../pairing/handshake';
import type { HandshakePeer, HandshakeResult } from '../pairing/handshake';
import { scannedPsk, forgetScannedPsk } from '../pairing/qr';
import { logger } from '../../services/log';
import {
  classifyConnectError,
  describeConnectFailure,
  looksSameSubnet,
  worthTryingAnotherAddress,
} from './connectErrors';
import { DeviceDiscovery } from '../../native';
import { DiscoveryService } from '../discovery/DiscoveryService';

const log = logger('session');

/**
 * An authenticated, live connection to one peer.
 */
export interface PeerSession {
  connectionId: string;
  peer: HandshakePeer;
  host: string;
  port: number;
  inbound: boolean;
  /** Our token — the peer quotes this to us. */
  sessionToken: string;
  /** The peer's token — we quote this to the peer. */
  peerSessionToken: string;
  expiresAt: number;
  establishedAt: number;
  /** Payload cipher in force for this connection. */
  cipher: CipherSuite;
}

export type SessionListener = (session: PeerSession) => void;
export type SessionEndListener = (deviceId: string, reason: string) => void;
export type SessionMessageListener = (
  session: PeerSession,
  message: ControlMessage,
) => void;

/** Asked when an unknown device dials us. Resolves true to accept. */
export type ApprovalRequester = (peer: HandshakePeer) => Promise<boolean>;

interface PendingConnection {
  connectionId: string;
  handshake: Handshake;
  host: string;
  port: number;
  inbound: boolean;
}

/**
 * Owns every peer connection: dialling out, accepting in, running the
 * handshake, and tearing down.
 *
 * Screens never touch this directly — the stores do. Above this layer a peer
 * is either "we have a session" or "we don't"; sockets, handshakes and
 * connection ids stay here.
 */
class SessionManagerImpl {
  private identity: LocalIdentity | null = null;
  private requestApproval: ApprovalRequester = async () => false;

  /** Handshake in flight, keyed by connectionId. */
  private pending = new Map<string, PendingConnection>();
  /** Established sessions, keyed by deviceId — the identity that matters. */
  private sessions = new Map<string, PeerSession>();
  /** Reverse index so a socket-level event can find its session. */
  private byConnection = new Map<string, string>();
  /** De-duplicates concurrent connect() calls for the same device. */
  private dialling = new Map<string, Promise<PeerSession>>();
  /**
   * Control frames that arrived before their connection was registered.
   *
   * Native now emits onConnection first, so this should stay empty — but
   * dropping a handshake frame is fatal and silent, so it is buffered rather
   * than trusted to ordering alone. Flushed the moment the handshake exists.
   */
  private earlyFrames = new Map<string, ControlMessage[]>();

  private subscriptions: EventSubscription[] = [];
  private started = false;

  private sessionListeners = new Set<SessionListener>();
  private endListeners = new Set<SessionEndListener>();
  private messageListeners = new Set<SessionMessageListener>();

  /** Bind the listener and start accepting inbound connections. */
  async start(
    identity: LocalIdentity,
    requestApproval: ApprovalRequester,
  ): Promise<number> {
    this.identity = identity;
    this.requestApproval = requestApproval;

    if (!this.started) {
      this.subscriptions.push(
        PeerConnection.onConnection((event) => this.onConnection(event)),
        PeerConnection.onControl((event) => this.onControl(event)),
        PeerConnection.onDisconnect((event) => this.onDisconnect(event)),
      );
      this.started = true;
    }

    const port = await PeerConnection.startServer();
    log.info(`listening on port ${port}`);
    return port;
  }

  async stop(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.disconnect(session.peer.deviceId).catch(() => undefined);
    }
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    this.started = false;
    await PeerConnection.stopServer().catch(() => undefined);
  }

  /** Keep the identity in sync when the user renames the device. */
  updateIdentity(identity: LocalIdentity): void {
    this.identity = identity;
  }

  session(deviceId: string): PeerSession | null {
    const session = this.sessions.get(deviceId) ?? null;
    if (session && session.expiresAt > 0 && session.expiresAt < Date.now()) {
      // Expired credential: drop it rather than let a stale token authorise a
      // transfer (§42).
      void this.disconnect(deviceId);
      return null;
    }
    return session;
  }

  isConnected(deviceId: string): boolean {
    return this.session(deviceId) !== null;
  }

  activeSessions(): PeerSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Get a usable session for a peer, reusing the existing one if there is one.
   *
   * This is the whole of "one-tap send" (§11) from the networking side: given
   * a device the user picked out of history, either we already have a trusted
   * connection or we make one with no user interaction beyond the peer's own
   * approval — no QR, no manual pairing, no IP entry.
   */
  async connect(peer: DiscoveredPeer): Promise<PeerSession> {
    const existing = this.session(peer.deviceId);
    if (existing) return existing;

    const inFlight = this.dialling.get(peer.deviceId);
    if (inFlight) return inFlight;

    const attempt = this.dial(peer).finally(() => {
      this.dialling.delete(peer.deviceId);
    });
    this.dialling.set(peer.deviceId, attempt);
    return attempt;
  }

  private async dial(peer: DiscoveredPeer): Promise<PeerSession> {
    const identity = this.requireIdentity();
    log.info(`dialling ${peer.deviceName}`, {
      deviceId: peer.deviceId,
      host: peer.host || '(bonjour service)',
      port: peer.port,
      serviceRef: peer.serviceRef ?? '',
    });

    const connectionId = await this.openSocket(peer);

    const handshake = new Handshake({
      role: 'initiator',
      identity,
      secrets: identitySecrets(),
      send: (message) => PeerConnection.send(connectionId, message),
      // The initiator never prompts: this user already chose this device.
      requestApproval: async () => true,
      scannedPskFor: scannedPsk,
    });

    this.pending.set(connectionId, {
      connectionId,
      handshake,
      host: peer.host,
      port: peer.port,
      inbound: false,
    });

    log.debug('initiator handshake armed', { connectionId });
    this.flushEarlyFrames(connectionId, handshake);

    try {
      const result = await handshake.start();
      return await this.promote(connectionId, result, peer.host, peer.port, false);
    } catch (error) {
      const reason = error instanceof HandshakeError ? error.reason : 'unknown';
      log.error(`handshake with ${peer.deviceName} failed (${reason})`, {
        message: error instanceof Error ? error.message : String(error),
      });
      this.pending.delete(connectionId);
      this.earlyFrames.delete(connectionId);
      await PeerConnection.disconnect(connectionId).catch(() => undefined);
      throw error instanceof HandshakeError
        ? error
        : new HandshakeError('timeout', String(error));
    }
  }

  /**
   * Open a socket to a peer, trying each address it offered.
   *
   * A device usually has several local addresses (Wi-Fi, hotspot bridge,
   * sometimes mobile data) and cannot know which one a given peer shares a
   * network with. Trying them in order turns a hard failure into a retry,
   * and the classification decides whether another address is even worth
   * attempting.
   */
  private async openSocket(peer: DiscoveredPeer): Promise<string> {
    const serviceRef = peer.serviceRef ?? '';
    const addresses = [peer.host, ...(peer.hosts ?? [])].filter(
      (value, index, all) => value.length > 0 && all.indexOf(value) === index,
    );

    // With a Bonjour endpoint the OS resolves the address itself, so there is
    // nothing to iterate.
    const attempts: { host: string; serviceRef: string }[] = serviceRef
      ? [{ host: '', serviceRef }]
      : addresses.map((host) => ({ host, serviceRef: '' }));

    if (attempts.length === 0) {
      throw new Error(
        `No reachable address known for ${peer.deviceName}. Try scanning its QR code.`,
      );
    }

    let lastError: unknown;
    for (const [index, attempt] of attempts.entries()) {
      try {
        const id = await PeerConnection.connect({
          host: attempt.host,
          port: peer.port,
          serviceRef: attempt.serviceRef,
        });
        if (index > 0) {
          log.info(
            `connected on fallback address ${attempt.host} after ${index} failure(s)`,
          );
        }
        return id;
      } catch (error) {
        lastError = error;
        const failure = classifyConnectError(error);
        log.warn(
          `connect to ${attempt.host || '(bonjour)'}:${peer.port} failed (${failure})`,
          { message: error instanceof Error ? error.message : String(error) },
        );
        if (!worthTryingAnotherAddress(failure)) break;
      }
    }

    const failure = classifyConnectError(lastError);

    // Our own addresses, so "no route to a device on our own subnet" can be
    // reported as what it actually is rather than as a vague network problem.
    const ourAddresses = await DeviceDiscovery.getNetworkInfo()
      .then((info) => info.addresses.map((entry) => entry.address))
      .catch(() => [] as string[]);
    const sameSubnet = addresses.some((host) =>
      looksSameSubnet(host, ourAddresses),
    );

    log.error(`could not reach ${peer.deviceName}: ${failure}`, {
      tried: attempts.map((attempt) => attempt.host || '(bonjour)'),
      port: peer.port,
      ourAddresses,
      sameSubnet,
      diagnosis:
        failure === 'no-route' && sameSubnet
          ? 'router is blocking client-to-client traffic (AP isolation)'
          : failure,
      raw: lastError instanceof Error ? lastError.message : String(lastError),
    });

    /**
     * Last resort: go around the router.
     *
     * `no-route` to a device we can *see* over mDNS means the router is
     * dropping traffic between its own clients. No address will ever work in
     * that case, so retrying is pointless — but a Wi-Fi Direct group has no
     * router in it at all, and the existing TCP path runs over it unchanged.
     *
     * Only attempted when Wi-Fi Direct is already enabled and this peer was
     * seen over it: forming a group is intrusive enough that it should not
     * happen behind the user's back.
     */
    if (failure === 'no-route') {
      const routed = await DiscoveryService.openWifiDirectRoute(peer.deviceId)
        .catch((error: unknown) => {
          log.warn('wi-fi direct fallback failed', error);
          return null;
        });

      if (routed) {
        log.info(`retrying ${peer.deviceName} over wi-fi direct`);
        return PeerConnection.connect({
          host: routed.host,
          port: routed.port,
          serviceRef: '',
        });
      }
    }

    const explanation = describeConnectFailure(failure, peer.deviceName, {
      // The peer came from the live discovery map, so multicast reached us —
      // it really is on this network.
      discoveredOnThisNetwork: true,
      sameSubnet,
    });
    // Thrown with the human explanation, because this is what the UI shows.
    throw new Error(explanation);
  }

  async disconnect(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    this.sessions.delete(deviceId);
    this.byConnection.delete(session.connectionId);
    await PeerConnection.send(session.connectionId, { t: 'BYE' }).catch(
      () => undefined,
    );
    await PeerConnection.disconnect(session.connectionId).catch(() => undefined);
    this.emitEnd(deviceId, 'disconnected');
  }

  /** Send a control message to an established session. */
  async send(deviceId: string, message: ControlMessage): Promise<void> {
    const session = this.session(deviceId);
    if (!session) {
      throw new Error('No active session for this device');
    }
    await PeerConnection.send(session.connectionId, message);
  }

  onSession(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  onSessionEnd(listener: SessionEndListener): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Control messages that arrive *after* the handshake completes. */
  onMessage(listener: SessionMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  // ------------------------------------------------------------ native events

  private onConnection(event: ConnectionEvent): void {
    log.info(
      `socket ${event.inbound ? 'accepted from' : 'opened to'} ${event.host}:${event.port}`,
      { connectionId: event.connectionId },
    );

    if (!event.inbound) return; // outbound sockets are handled inside dial()

    const identity = this.identity;
    if (!identity) {
      log.warn('inbound socket before startup finished — dropping', event);
      void PeerConnection.disconnect(event.connectionId);
      return;
    }

    const handshake = new Handshake({
      role: 'responder',
      identity,
      secrets: identitySecrets(),
      send: (message) => PeerConnection.send(event.connectionId, message),
      requestApproval: (peer) => this.requestApproval(peer),
      scannedPskFor: scannedPsk,
    });

    this.pending.set(event.connectionId, {
      connectionId: event.connectionId,
      handshake,
      host: event.host,
      port: event.port,
      inbound: true,
    });

    log.debug('responder handshake armed', { connectionId: event.connectionId });
    this.flushEarlyFrames(event.connectionId, handshake);

    handshake
      .start()
      .then((result) =>
        this.promote(event.connectionId, result, event.host, event.port, true),
      )
      .catch((error: unknown) => {
        log.warn('inbound handshake failed', {
          connectionId: event.connectionId,
          reason: error instanceof HandshakeError ? error.reason : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
        this.pending.delete(event.connectionId);
        this.earlyFrames.delete(event.connectionId);
        void PeerConnection.disconnect(event.connectionId).catch(() => undefined);
      });
  }

  /**
   * Hand a newly armed handshake anything that arrived before it existed.
   *
   * Delivered on a microtask so the handshake's own `start()` has run and set
   * its initial phase; feeding it synchronously here would hit the phase guard
   * and the frame would be discarded a second time.
   */
  private flushEarlyFrames(connectionId: string, handshake: Handshake): void {
    const queued = this.earlyFrames.get(connectionId);
    if (!queued || queued.length === 0) return;
    this.earlyFrames.delete(connectionId);

    log.warn(
      `replaying ${queued.length} frame(s) that arrived before registration`,
      { connectionId, types: queued.map((message) => message.t) },
    );
    void Promise.resolve().then(() => {
      for (const message of queued) handshake.handle(message);
    });
  }

  private onControl(event: ControlEvent): void {
    const type = event.message?.t ?? '(unparsed)';
    log.debug(`<- ${type}`, { connectionId: event.connectionId });

    const pending = this.pending.get(event.connectionId);
    if (pending) {
      pending.handshake.handle(event.message);
      return;
    }

    const deviceId = this.byConnection.get(event.connectionId);
    if (!deviceId) {
      // No handshake and no session for this connection yet. Hold the frame
      // rather than discarding it — see `earlyFrames`.
      const queued = this.earlyFrames.get(event.connectionId) ?? [];
      queued.push(event.message);
      this.earlyFrames.set(event.connectionId, queued);
      return;
    }
    const session = this.sessions.get(deviceId);
    if (!session) {
      log.warn('control frame for a connection with no session', {
        connectionId: event.connectionId,
        type,
      });
      return;
    }

    if (event.message.t === 'BYE') {
      void this.handleRemoteClose(session, 'peer closed the connection');
      return;
    }

    for (const listener of this.messageListeners) {
      listener(session, event.message);
    }
  }

  private onDisconnect(event: DisconnectEvent): void {
    log.info(`socket closed: ${event.reason}`, {
      connectionId: event.connectionId,
    });
    this.earlyFrames.delete(event.connectionId);
    const pending = this.pending.get(event.connectionId);
    if (pending) {
      pending.handshake.abort('timeout');
      this.pending.delete(event.connectionId);
      return;
    }

    const deviceId = this.byConnection.get(event.connectionId);
    if (!deviceId) return;
    const session = this.sessions.get(deviceId);
    if (session) void this.handleRemoteClose(session, event.reason);
  }

  private async handleRemoteClose(
    session: PeerSession,
    reason: string,
  ): Promise<void> {
    this.sessions.delete(session.peer.deviceId);
    this.byConnection.delete(session.connectionId);
    this.emitEnd(session.peer.deviceId, reason);
  }

  /**
   * A handshake succeeded: register the session and record the device.
   *
   * This is where a device enters history (§9/§44) — on a *successful,
   * authenticated connection*, not on mere discovery.
   */
  private async promote(
    connectionId: string,
    result: HandshakeResult,
    host: string,
    port: number,
    inbound: boolean,
  ): Promise<PeerSession> {
    this.pending.delete(connectionId);

    // If we somehow already have a session for this device (both sides dialled
    // at once), keep the older one and drop this socket.
    const existing = this.sessions.get(result.peer.deviceId);
    if (existing) {
      await PeerConnection.disconnect(connectionId).catch(() => undefined);
      return existing;
    }

    const session: PeerSession = {
      connectionId,
      peer: result.peer,
      host,
      port,
      inbound,
      sessionToken: result.sessionToken,
      peerSessionToken: result.peerSessionToken,
      expiresAt: result.expiresAt,
      establishedAt: Date.now(),
      cipher: result.cipher,
    };

    this.sessions.set(result.peer.deviceId, session);
    this.byConnection.set(connectionId, result.peer.deviceId);
    log.info(
      `session established with ${result.peer.deviceName} ` +
        `(trust: ${result.trustMethod}, cipher: ${result.cipher})`,
      { deviceId: result.peer.deviceId, fingerprint: result.peer.fingerprint },
    );

    // Hands the negotiated key to the native data path, which is what turns
    // payload encryption on. Only when a cipher was actually agreed: without
    // this check a peer that cannot decrypt would receive ciphertext it would
    // silently write to disk as garbage.
    if (result.cipher !== CIPHER_NONE) {
      await PeerConnection.setSessionKey(connectionId, result.sessionKey);
    }

    await deviceRepository.upsertOnConnect({
      deviceId: result.peer.deviceId,
      deviceName: result.peer.deviceName,
      platform: result.peer.platform,
      deviceType: result.peer.deviceType,
      host,
      port,
    });

    forgetScannedPsk(result.peer.deviceId);

    for (const listener of this.sessionListeners) listener(session);
    return session;
  }

  private emitEnd(deviceId: string, reason: string): void {
    for (const listener of this.endListeners) listener(deviceId, reason);
  }

  private requireIdentity(): LocalIdentity {
    if (!this.identity) {
      throw new Error('SessionManager used before start()');
    }
    return this.identity;
  }
}

export const SessionManager = new SessionManagerImpl();
