/**
 * FortShare wire-protocol constants.
 *
 * These values are the contract between the TypeScript control plane and the
 * native data plane, and between any two FortShare devices. Changing one is a
 * protocol break: bump PROTOCOL_VERSION when you do.
 */

/** Bumped on any incompatible change to framing, handshake or control messages. */
export const PROTOCOL_VERSION = 1;

/** DNS-SD service type. Both Android (NSD) and iOS (Bonjour) advertise this. */
export const SERVICE_TYPE = '_fortshare._tcp';
export const SERVICE_DOMAIN = 'local.';

/** 8-byte per-connection preamble: "FSHARE" + 0x00 + version. */
export const HELLO_MAGIC = 'FSHARE';

/**
 * Bytes per DATA frame payload. 256 KB is large enough to keep syscall
 * overhead irrelevant on gigabit Wi-Fi and small enough that a single reusable
 * buffer per direction is all the memory a transfer ever needs.
 */
export const CHUNK_SIZE = 256 * 1024;

/** Receiver sends CHUNK_ACK roughly this often. Drives the sender's UI only. */
export const ACK_INTERVAL_BYTES = 2 * 1024 * 1024;

/** Native emits progress at most this often, per file, per direction. */
export const PROGRESS_THROTTLE_MS = 250;

/** Handshake must complete inside this window or the socket is dropped. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** A pairing prompt the user never answers expires rather than hanging. */
export const PAIR_REQUEST_TIMEOUT_MS = 60_000;

/** Session credentials expire; nothing resumable is authorised by a stale one. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** A QR pairing token is single-use and short-lived. */
export const QR_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Liveness. A peer that misses this many PONGs is considered gone. */
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 25_000;

/** Suffix for a partially received file. Renamed away only after verification. */
export const PART_SUFFIX = '.fortshare-part';

/** HKDF domain separation. */
export const KDF_CONTEXT = 'FortShare/v1';
export const KDF_INFO_SESSION = 'fortshare-session-key';
export const KDF_INFO_TOKEN = 'fortshare-session-token';
export const KDF_INFO_QR = 'fortshare-qr-proof';

/** Frame type bytes, mirrored in FortShareFrames.kt and FrameCodec.swift. */
export const FrameType = {
  CONTROL: 0x01,
  DATA: 0x02,
  PING: 0x03,
  PONG: 0x04,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];
