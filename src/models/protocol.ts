import type { DeviceType, Platform } from './device';
import type { DuplicateResolution, TransferPauseReason } from './transfer';

/**
 * Every CONTROL frame payload, as a discriminated union on `t`.
 *
 * This file is the single definition of the FortShare protocol. Because the
 * control plane lives in TypeScript on both platforms, there is exactly one
 * implementation of it — Android/iOS compatibility is structural rather than
 * something that has to be tested into existence.
 */

/** Peer identity + ephemeral key material. First message on every connection. */
export interface HelloMessage {
  t: 'HELLO';
  v: number;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  deviceType: DeviceType;
  /** base64url Ed25519 static public key. */
  edPub: string;
  /** base64url X25519 static public key. */
  xPub: string;
  /** base64url X25519 ephemeral public key, fresh per connection. */
  ephPub: string;
  /** base64url 32 random bytes, fresh per connection. Blocks replay. */
  nonce: string;
  chunkSize: number;
}

/** The responder's HELLO. Same shape, distinct tag to keep the FSM explicit. */
export interface HelloAckMessage extends Omit<HelloMessage, 't'> {
  t: 'HELLO_ACK';
}

/**
 * Proof that the sender holds the private key for the `edPub` it presented.
 * The signature covers a transcript binding both nonces, both static keys and
 * both ephemeral keys, so it cannot be replayed into another session.
 */
export interface AuthMessage {
  t: 'AUTH';
  /** base64url Ed25519 signature over the handshake transcript. */
  sig: string;
  /**
   * base64url HMAC(qrPsk, transcript). Present only when the sender scanned
   * this peer's QR code: it authenticates the key out of band, which is what
   * defeats a man-in-the-middle on first contact.
   */
  pskProof?: string;
}

export interface AuthOkMessage {
  t: 'AUTH_OK';
  /** Derived from the handshake. Memory-only, expiring. */
  sessionToken: string;
  expiresAt: number;
}

export interface AuthFailMessage {
  t: 'AUTH_FAIL';
  reason:
    | 'bad-signature'
    | 'bad-psk'
    | 'version-mismatch'
    | 'key-mismatch'
    | 'rejected'
    | 'timeout'
    /**
     * Something failed on our side — a failed database write, for example.
     * Kept distinct from `bad-signature` so a local fault is never reported
     * as the peer having failed authentication.
     */
    | 'internal';
  detail?: string;
}

/** Sent when the peer is unknown to us and the user must decide. */
export interface PairRequestMessage {
  t: 'PAIR_REQUEST';
  deviceName: string;
}
export interface PairAcceptMessage {
  t: 'PAIR_ACCEPT';
}
export interface PairRejectMessage {
  t: 'PAIR_REJECT';
}

export interface OfferedFile {
  fileId: string;
  fileIndex: number;
  name: string;
  size: number;
  mimeType: string;
  /** Hex SHA-256, computed natively over the whole file before offering. */
  sha256: string;
}

export interface TransferOfferMessage {
  t: 'TRANSFER_OFFER';
  transferId: string;
  sessionToken: string;
  files: OfferedFile[];
  totalBytes: number;
}

export interface AcceptedFile {
  fileId: string;
  /** Byte offset the sender should start from. Non-zero means resume. */
  startOffset: number;
  resolution: DuplicateResolution;
}

export interface TransferAcceptMessage {
  t: 'TRANSFER_ACCEPT';
  transferId: string;
  files: AcceptedFile[];
}

export interface TransferRejectMessage {
  t: 'TRANSFER_REJECT';
  transferId: string;
  reason: string;
}

/** Announces that DATA frames for `fileIndex` begin at `offset`. */
export interface FileBeginMessage {
  t: 'FILE_BEGIN';
  transferId: string;
  fileId: string;
  fileIndex: number;
  offset: number;
  size: number;
}

/** Receiver → sender, roughly every ACK_INTERVAL_BYTES. Drives the sender UI. */
export interface ChunkAckMessage {
  t: 'CHUNK_ACK';
  transferId: string;
  fileId: string;
  receivedBytes: number;
}

/** Sender's declared digest, sent after the last DATA frame for a file. */
export interface FileEndMessage {
  t: 'FILE_END';
  transferId: string;
  fileId: string;
  sha256: string;
}

/** Receiver's independently computed digest. `ok` is the verification verdict. */
export interface FileVerifiedMessage {
  t: 'FILE_VERIFIED';
  transferId: string;
  fileId: string;
  ok: boolean;
  sha256: string;
}

export interface TransferDoneMessage {
  t: 'TRANSFER_DONE';
  transferId: string;
  filesCompleted: number;
  filesFailed: number;
}

export interface TransferPauseMessage {
  t: 'TRANSFER_PAUSE';
  transferId: string;
  reason: TransferPauseReason;
}

/** "What do you already have?" — the first half of resume. */
export interface TransferResumeMessage {
  t: 'TRANSFER_RESUME';
  transferId: string;
  sessionToken: string;
}

/**
 * The receiver's answer, derived from the actual length of each `.part` file
 * on disk. This is the only authority on resume offsets: a sender cannot know
 * whether its final write to a dying socket landed.
 */
export interface ResumeStateMessage {
  t: 'RESUME_STATE';
  transferId: string;
  files: { fileId: string; receivedBytes: number }[];
  /** False when the receiver has no record of this transfer any more. */
  known: boolean;
}

export interface TransferCancelMessage {
  t: 'TRANSFER_CANCEL';
  transferId: string;
}

/** Sent on graceful teardown so the peer can distinguish it from a drop. */
export interface ByeMessage {
  t: 'BYE';
}

export type ControlMessage =
  | HelloMessage
  | HelloAckMessage
  | AuthMessage
  | AuthOkMessage
  | AuthFailMessage
  | PairRequestMessage
  | PairAcceptMessage
  | PairRejectMessage
  | TransferOfferMessage
  | TransferAcceptMessage
  | TransferRejectMessage
  | FileBeginMessage
  | ChunkAckMessage
  | FileEndMessage
  | FileVerifiedMessage
  | TransferDoneMessage
  | TransferPauseMessage
  | TransferResumeMessage
  | ResumeStateMessage
  | TransferCancelMessage
  | ByeMessage;

export type ControlMessageType = ControlMessage['t'];

/** Narrows a parsed control message by tag without a cast at the call site. */
export function isMessage<T extends ControlMessageType>(
  msg: ControlMessage,
  type: T,
): msg is Extract<ControlMessage, { t: T }> {
  return msg.t === type;
}

/**
 * Payload of a FortShare QR code. Contains only what is needed to reach and
 * authenticate one device once — no account, no private key, no history.
 */
export interface QrPayload {
  v: number;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  deviceType: DeviceType;
  avatar: string;
  edPub: string;
  fingerprint: string;
  host: string;
  /**
   * Every address the generating device could be reached on, best first.
   *
   * `host` is kept as the first entry for compatibility, but a scanner should
   * try all of these: the generating device cannot know which of its own
   * addresses the scanner shares a network with, and guessing wrong is what
   * produces "no route to host".
   */
  hosts?: string[];
  port: number;
  /** base64url 32 random bytes. Single-use, expires at `exp`. */
  psk: string;
  exp: number;
}
