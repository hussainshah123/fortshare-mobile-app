import {
  CHUNK_SIZE,
  CIPHER_NONE,
  SUPPORTED_CIPHERS,
  HANDSHAKE_TIMEOUT_MS,
  PAIR_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  type CipherSuite,
} from '../../constants/protocol';
import type {
  AuthFailMessage,
  ControlMessage,
  HelloAckMessage,
  HelloMessage,
} from '../../models/protocol';
import type {
  DeviceType,
  LocalIdentity,
  PairingMethod,
  Platform,
} from '../../models/device';
import {
  deriveSession,
  fingerprintOf,
  generateEphemeral,
  handshakeTranscript,
  qrProof,
  randomNonce,
  signTranscript,
  verifyQrProof,
  verifyTranscript,
  type TranscriptParty,
} from '../../services/crypto';
import { evaluateTrust, pinTrust } from './trust';
import { activeTokens, consumableToken, redeemToken } from './qr';

/** Identity a peer presented and we verified. */
export interface HandshakePeer {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  deviceType: DeviceType;
  edPub: string;
  xPub: string;
  fingerprint: string;
  chunkSize: number;
}

export interface HandshakeResult {
  peer: HandshakePeer;
  sessionKey: string;
  /** Our token, which the peer must quote when offering us a transfer. */
  sessionToken: string;
  /** The peer's token, which we must quote when offering it a transfer. */
  peerSessionToken: string;
  expiresAt: number;
  trustMethod: PairingMethod;
  /**
   * Payload cipher both peers agreed on.
   *
   * `none` means the peer could not do better — the transfer still runs, but
   * the UI says so rather than implying protection that is not there.
   */
  cipher: CipherSuite;
}

export type HandshakeFailure = AuthFailMessage['reason'];

export class HandshakeError extends Error {
  constructor(
    public readonly reason: HandshakeFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'HandshakeError';
  }
}

export interface HandshakeOptions {
  role: 'initiator' | 'responder';
  identity: LocalIdentity;
  secrets: { edSecretKey: string; xSecretKey: string };
  send: (message: ControlMessage) => Promise<void>;
  /**
   * Ask the user about an unknown peer. Only ever called on the responder —
   * the initiator's user already chose this device by tapping it.
   */
  requestApproval: (peer: HandshakePeer) => Promise<boolean>;
  /** A PSK we hold because we scanned this peer's QR code. */
  scannedPskFor: (deviceId: string) => string | null;
}

type Phase =
  | 'idle'
  | 'awaiting-hello'
  | 'awaiting-hello-ack'
  | 'awaiting-auth'
  | 'awaiting-user'
  | 'awaiting-auth-ok'
  | 'done'
  | 'failed';

/**
 * The FortShare authenticated handshake (§15).
 *
 *   A                                          B
 *   HELLO      ──────────────────────────────►
 *              ◄──────────────────────────  HELLO_ACK
 *   AUTH (sig over transcript, +QR proof) ───►
 *              ◄─────  [PAIR_REQUEST, user decides]
 *              ◄──────────────────────────  AUTH, AUTH_OK
 *   AUTH_OK    ──────────────────────────────►
 *
 * Only the responder prompts its user. The initiator does not, because its
 * user picked this device deliberately — which is exactly the "tap a device,
 * the other side accepts, done" flow §44 describes.
 */
export class Handshake {
  private phase: Phase = 'idle';
  private readonly ephemeral = generateEphemeral();
  private readonly nonce = randomNonce();
  private peerHello: HelloMessage | HelloAckMessage | null = null;
  private transcript: Uint8Array | null = null;
  private sessionKey = '';
  private ownToken = '';
  private peerToken = '';
  private expiresAt = 0;
  private trustMethod: PairingMethod = 'auto';
  private cipher: CipherSuite = CIPHER_NONE;
  private peerAuthVerified = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Serialises inbound frames.
   *
   * The handshake is a strictly sequential protocol, so it has to be *driven*
   * sequentially. Dispatching each frame without awaiting the previous one let
   * AUTH_OK be processed while AUTH was still awaiting its database write, so
   * `peerAuthVerified` was still false and the peer was accused of skipping
   * authentication. Chaining makes out-of-order processing impossible.
   */
  private chain: Promise<void> = Promise.resolve();
  private settle: {
    resolve: (result: HandshakeResult) => void;
    reject: (error: HandshakeError) => void;
  } | null = null;

  constructor(private readonly options: HandshakeOptions) {}

  /** Drives the handshake to completion. Rejects with a HandshakeError. */
  start(): Promise<HandshakeResult> {
    const promise = new Promise<HandshakeResult>((resolve, reject) => {
      this.settle = { resolve, reject };
    });

    this.arm(HANDSHAKE_TIMEOUT_MS);

    if (this.options.role === 'initiator') {
      this.phase = 'awaiting-hello-ack';
      void this.sendSafely(this.buildHello('HELLO'));
    } else {
      this.phase = 'awaiting-hello';
    }

    return promise;
  }

  /**
   * Feed every CONTROL frame for this connection here until it settles.
   *
   * Frames are queued and processed one at a time in arrival order: a step
   * that awaits a database write or a user decision must finish before the
   * next frame is looked at.
   */
  handle(message: ControlMessage): void {
    if (this.phase === 'done' || this.phase === 'failed') return;

    this.chain = this.chain
      .then(() => {
        // Re-checked inside the chain: an earlier frame may have settled the
        // handshake while this one was queued.
        if (this.phase === 'done' || this.phase === 'failed') return;
        return this.dispatch(message);
      })
      .catch((error: unknown) => {
      // An unexpected throw is *our* fault, not a failed signature. Reporting
      // it as 'bad-signature' previously turned a local database error into a
      // security-looking message that pointed at the wrong thing entirely.
      const failure =
        error instanceof HandshakeError
          ? error
          : new HandshakeError(
              'internal',
              error instanceof Error ? error.message : 'handshake failed',
            );
      if (!(error instanceof HandshakeError)) {
        console.error('[FortShare] handshake fault', error);
      }

      // Tell the peer *why* before hanging up. Without this the other side
      // sits on a 15-second timeout and shows "stopped responding" instead of
      // the real reason — a version mismatch, a rejected pairing, a key that
      // does not match the one we pinned.
      void this.rejectPeer(failure.reason);
      this.fail(failure);
    });
  }

  /** Called when the socket dies underneath us. */
  abort(reason: HandshakeFailure = 'timeout'): void {
    this.fail(new HandshakeError(reason));
  }

  // ------------------------------------------------------------------ phases

  private async dispatch(message: ControlMessage): Promise<void> {
    switch (message.t) {
      case 'HELLO':
        if (this.phase !== 'awaiting-hello') return;
        this.acceptPeerHello(message);
        this.phase = 'awaiting-auth';
        await this.sendSafely(this.buildHello('HELLO_ACK'));
        return;

      case 'HELLO_ACK': {
        if (this.phase !== 'awaiting-hello-ack') return;
        this.acceptPeerHello(message);
        // Advance the phase *before* awaiting the send: the peer's AUTH can
        // arrive while our own send promise is still settling, and the phase
        // guard below would otherwise discard it and strand the handshake.
        this.phase = 'awaiting-auth';
        await this.sendAuth();
        return;
      }

      case 'AUTH': {
        if (this.phase !== 'awaiting-auth') return;
        await this.verifyPeerAuth(message.sig, message.pskProof);
        this.peerAuthVerified = true;

        if (this.options.role === 'responder') {
          // Our turn to prove ourselves, then hand over a session.
          await this.sendAuth();
          this.expiresAt = Date.now() + SESSION_TTL_MS;
          await this.sendSafely({
            t: 'AUTH_OK',
            sessionToken: this.ownToken,
            expiresAt: this.expiresAt,
          });
          this.phase = 'awaiting-auth-ok';
        } else {
          this.phase = 'awaiting-auth-ok';
        }
        return;
      }

      case 'AUTH_OK': {
        if (!this.peerAuthVerified) {
          throw new HandshakeError(
            'bad-signature',
            'peer sent AUTH_OK before proving its identity',
          );
        }
        this.peerToken = message.sessionToken;
        this.expiresAt = this.expiresAt || message.expiresAt;

        if (this.options.role === 'initiator') {
          // Reciprocate so the responder also holds a token from us.
          await this.sendSafely({
            t: 'AUTH_OK',
            sessionToken: this.ownToken,
            expiresAt: this.expiresAt,
          });
        }
        this.succeed();
        return;
      }

      case 'AUTH_FAIL':
        throw new HandshakeError(message.reason, message.detail);

      case 'PAIR_REQUEST':
        // Informational: the peer is asking its user about us. Extend our
        // patience to a human timescale rather than a network one.
        this.arm(PAIR_REQUEST_TIMEOUT_MS);
        return;

      case 'PAIR_REJECT':
        throw new HandshakeError('rejected', 'the other device declined');

      default:
        // Anything else before the session exists is out of order and ignored.
        return;
    }
  }

  private acceptPeerHello(message: HelloMessage | HelloAckMessage): void {
    if (message.v !== PROTOCOL_VERSION) {
      throw new HandshakeError(
        'version-mismatch',
        `peer speaks protocol v${message.v}, we speak v${PROTOCOL_VERSION}`,
      );
    }
    if (message.deviceId === this.options.identity.deviceId) {
      throw new HandshakeError('rejected', 'refusing to pair with ourselves');
    }

    this.peerHello = message;

    // Best cipher both sides can speak. Order comes from our own preference
    // list, so a peer cannot talk us down to a weaker choice than we would
    // have picked ourselves.
    const theirs = new Set(message.ciphers ?? [CIPHER_NONE]);
    this.cipher =
      SUPPORTED_CIPHERS.find((candidate) => theirs.has(candidate)) ?? CIPHER_NONE;

    this.transcript = handshakeTranscript(this.selfParty(), this.peerParty());

    const session = deriveSession(
      this.ephemeral.secretKey,
      message.ephPub,
      this.transcript,
    );
    this.sessionKey = session.sessionKey;
    this.ownToken = session.sessionToken;
  }

  /**
   * Verify the peer's signature, then decide how much to trust it.
   *
   * The signature only proves the peer holds the key it presented. Whether we
   * *care* about that key is the separate question {@link evaluateTrust}
   * answers.
   */
  private async verifyPeerAuth(
    signature: string,
    pskProof: string | undefined,
  ): Promise<void> {
    const peer = this.requirePeer();
    const transcript = this.requireTranscript();

    if (!verifyTranscript(transcript, signature, peer.edPub)) {
      throw new HandshakeError(
        'bad-signature',
        'peer could not prove it owns the key it presented',
      );
    }

    const decision = await evaluateTrust(peer.deviceId, peer.edPub);

    if (decision.kind === 'key-mismatch') {
      // The whole point of pinning. A remembered deviceId presented with a
      // different key is refused loudly rather than quietly re-pinned.
      throw new HandshakeError(
        'key-mismatch',
        `${peer.deviceName} presented a different identity key ` +
          `(expected ${decision.storedFingerprint}, got ${decision.presentedFingerprint}). ` +
          'Re-pair deliberately if this device was reinstalled.',
      );
    }

    if (decision.kind === 'trusted') {
      this.trustMethod = decision.method;
      return;
    }

    // Unknown or revoked: a QR proof, or the user, has to let it in.
    if (pskProof && this.redeemQrProof(peer.deviceId, pskProof, transcript)) {
      this.trustMethod = 'qr';
      await pinTrust({
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        platform: peer.platform,
        deviceType: peer.deviceType,
        edPublicKey: peer.edPub,
        xPublicKey: peer.xPub,
        method: 'qr',
      });
      return;
    }

    if (this.options.role === 'initiator') {
      // We dialled them: our user already chose this device, and the
      // signature above proves the peer owns the identity it advertised.
      this.trustMethod = 'auto';
      await pinTrust({
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        platform: peer.platform,
        deviceType: peer.deviceType,
        edPublicKey: peer.edPub,
        xPublicKey: peer.xPub,
        method: 'auto',
      });
      return;
    }

    // Responder, unknown peer: ask. Nothing is pinned until a human agrees.
    this.phase = 'awaiting-user';
    this.arm(PAIR_REQUEST_TIMEOUT_MS);
    await this.sendSafely({
      t: 'PAIR_REQUEST',
      deviceName: this.options.identity.deviceName,
    });

    const approved = await this.options.requestApproval(peer);
    if (!approved) {
      await this.sendSafely({ t: 'PAIR_REJECT' });
      throw new HandshakeError('rejected', 'you declined the pairing request');
    }

    await this.sendSafely({ t: 'PAIR_ACCEPT' });
    this.trustMethod = 'manual';
    await pinTrust({
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      platform: peer.platform,
      deviceType: peer.deviceType,
      edPublicKey: peer.edPub,
      xPublicKey: peer.xPub,
      method: 'manual',
    });
    this.phase = 'awaiting-auth';
    this.arm(HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * Check a QR proof against every PSK we have issued and not yet burned.
   *
   * We try all live tokens rather than requiring the peer to say which one it
   * used, so the QR payload need not echo anything back. A match is redeemed
   * immediately: a captured proof cannot be reused by a second peer.
   */
  private redeemQrProof(
    deviceId: string,
    proof: string,
    transcript: Uint8Array,
  ): boolean {
    for (const psk of activeTokens()) {
      if (!consumableToken(psk)) continue;
      if (verifyQrProof(psk, transcript, proof)) {
        redeemToken(psk, deviceId);
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------- pieces

  private buildHello(tag: 'HELLO' | 'HELLO_ACK'): HelloMessage | HelloAckMessage {
    const identity = this.options.identity;
    return {
      t: tag,
      v: PROTOCOL_VERSION,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      platform: identity.platform,
      deviceType: identity.deviceType,
      edPub: identity.edPublicKey,
      xPub: identity.xPublicKey,
      ephPub: this.ephemeral.publicKey,
      nonce: this.nonce,
      chunkSize: CHUNK_SIZE,
      ciphers: SUPPORTED_CIPHERS,
    };
  }

  private async sendAuth(): Promise<void> {
    const peer = this.requirePeer();
    const transcript = this.requireTranscript();
    const psk = this.options.scannedPskFor(peer.deviceId);
    await this.sendSafely({
      t: 'AUTH',
      sig: signTranscript(transcript, this.options.secrets.edSecretKey),
      ...(psk ? { pskProof: qrProof(psk, transcript) } : {}),
    });
  }

  private selfParty(): TranscriptParty {
    const identity = this.options.identity;
    return {
      deviceId: identity.deviceId,
      edPub: identity.edPublicKey,
      xPub: identity.xPublicKey,
      ephPub: this.ephemeral.publicKey,
      nonce: this.nonce,
    };
  }

  private peerParty(): TranscriptParty {
    const hello = this.peerHello;
    if (!hello) throw new HandshakeError('internal', 'peer HELLO missing');
    return {
      deviceId: hello.deviceId,
      edPub: hello.edPub,
      xPub: hello.xPub,
      ephPub: hello.ephPub,
      nonce: hello.nonce,
    };
  }

  private requirePeer(): HandshakePeer {
    const hello = this.peerHello;
    if (!hello) throw new HandshakeError('internal', 'peer HELLO missing');
    return {
      deviceId: hello.deviceId,
      deviceName: hello.deviceName,
      platform: hello.platform,
      deviceType: hello.deviceType,
      edPub: hello.edPub,
      xPub: hello.xPub,
      fingerprint: fingerprintOf(hello.edPub),
      chunkSize: Math.min(hello.chunkSize || CHUNK_SIZE, CHUNK_SIZE),
    };
  }

  private requireTranscript(): Uint8Array {
    if (!this.transcript) {
      throw new HandshakeError('internal', 'transcript not established');
    }
    return this.transcript;
  }

  /**
   * Best-effort "this is why I am hanging up".
   *
   * Never throws: the socket may already be gone, and a failure to report a
   * failure must not mask the original one.
   */
  private async rejectPeer(reason: HandshakeFailure): Promise<void> {
    try {
      await this.options.send({ t: 'AUTH_FAIL', reason });
    } catch {
      // The peer is unreachable; the local rejection still stands.
    }
  }

  private async sendSafely(message: ControlMessage): Promise<void> {
    try {
      await this.options.send(message);
    } catch (error) {
      throw new HandshakeError(
        'timeout',
        error instanceof Error ? error.message : 'send failed',
      );
    }
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fail(new HandshakeError('timeout', 'the other device stopped responding'));
    }, ms);
  }

  private succeed(): void {
    if (this.phase === 'done' || this.phase === 'failed') return;
    const peer = this.requirePeer();
    this.phase = 'done';
    this.disarm();
    this.settle?.resolve({
      peer,
      sessionKey: this.sessionKey,
      sessionToken: this.ownToken,
      peerSessionToken: this.peerToken,
      expiresAt: this.expiresAt,
      trustMethod: this.trustMethod,
      cipher: this.cipher,
    });
    this.settle = null;
  }

  private fail(error: HandshakeError): void {
    if (this.phase === 'done' || this.phase === 'failed') return;
    this.phase = 'failed';
    this.disarm();
    this.settle?.reject(error);
    this.settle = null;
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
