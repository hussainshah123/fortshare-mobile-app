import { PROTOCOL_VERSION, QR_TOKEN_TTL_MS } from '../../constants/protocol';
import type { QrPayload } from '../../models/protocol';
import type { DeviceType, LocalIdentity, Platform } from '../../models/device';
import { generatePsk } from '../../services/crypto';

/**
 * QR pairing (§14).
 *
 * The QR carries only what is needed to reach and authenticate one device
 * once: an address, a public key, and a single-use pre-shared key. No account,
 * no private key, no history, and nothing that identifies the user beyond the
 * device name they chose. No server is contacted at any point — the code is
 * generated on one device and verified on the other.
 */

/** PSKs we have issued and are still willing to accept, keyed by the PSK itself. */
interface IssuedToken {
  psk: string;
  expiresAt: number;
  /** Set once redeemed. A PSK is single-use. */
  redeemedBy?: string;
}

const issued = new Map<string, IssuedToken>();

export interface GeneratedQr {
  payload: QrPayload;
  /** The string to render as a QR code. */
  encoded: string;
  expiresAt: number;
}

/**
 * Mint a QR code for this device. The PSK is remembered locally so we can
 * verify the proof the scanner sends back during its handshake.
 */
export function generateQr(
  identity: LocalIdentity,
  host: string,
  port: number,
  /** Fallback addresses, so a scanner is not limited to one guess. */
  hosts: string[] = [],
): GeneratedQr {
  pruneExpired();

  const psk = generatePsk();
  const expiresAt = Date.now() + QR_TOKEN_TTL_MS;
  issued.set(psk, { psk, expiresAt });

  const payload: QrPayload = {
    v: PROTOCOL_VERSION,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    platform: identity.platform,
    deviceType: identity.deviceType,
    avatar: identity.avatar,
    edPub: identity.edPublicKey,
    fingerprint: identity.fingerprint,
    host,
    // `host` first, then anything else this device answers on. The generating
    // device cannot know which of its addresses the scanner shares a network
    // with, so it offers all of them.
    hosts: [host, ...hosts].filter(
      (value, index, all) => value.length > 0 && all.indexOf(value) === index,
    ),
    port,
    psk,
    exp: expiresAt,
  };

  return { payload, encoded: JSON.stringify(payload), expiresAt };
}

export type QrParseResult =
  | { ok: true; payload: QrPayload }
  | { ok: false; reason: 'malformed' | 'not-fortshare' | 'version' | 'expired' };

/**
 * Parse a scanned code.
 *
 * Returns a reason rather than throwing, because the camera will hand us every
 * barcode it sees — most of which are not FortShare codes — and a scanning
 * screen must not crash on someone's boarding pass.
 */
export function parseQr(raw: string): QrParseResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, reason: 'malformed' };
  }
  const obj = candidate as Record<string, unknown>;

  const required: (keyof QrPayload)[] = [
    'v',
    'deviceId',
    'deviceName',
    'platform',
    'edPub',
    'fingerprint',
    'host',
    'port',
    'psk',
    'exp',
  ];
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      return { ok: false, reason: 'not-fortshare' };
    }
  }

  if (typeof obj.v !== 'number' || typeof obj.port !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (obj.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'version' };
  }
  if (typeof obj.exp !== 'number' || obj.exp < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    payload: {
      v: obj.v,
      deviceId: String(obj.deviceId),
      deviceName: String(obj.deviceName),
      platform: String(obj.platform) as Platform,
      deviceType: (obj.deviceType ? String(obj.deviceType) : 'phone') as DeviceType,
      avatar: obj.avatar ? String(obj.avatar) : '',
      edPub: String(obj.edPub),
      fingerprint: String(obj.fingerprint),
      host: String(obj.host),
      hosts: Array.isArray(obj.hosts)
        ? obj.hosts.map(String).filter((value) => value.length > 0)
        : [String(obj.host)],
      port: obj.port,
      psk: String(obj.psk),
      exp: obj.exp,
    },
  };
}

/**
 * Look up a PSK we issued, if it is still valid and unredeemed.
 *
 * Returns null for unknown, expired or already-used tokens — all three mean
 * "do not grant trust on the strength of this proof".
 */
export function consumableToken(psk: string): IssuedToken | null {
  pruneExpired();
  const token = issued.get(psk);
  if (!token) return null;
  if (token.redeemedBy) return null;
  if (token.expiresAt < Date.now()) return null;
  return token;
}

/** Burn a PSK so a captured proof cannot be replayed by a second peer. */
export function redeemToken(psk: string, deviceId: string): void {
  const token = issued.get(psk);
  if (token) token.redeemedBy = deviceId;
}

/** All currently valid PSKs, for verifying an incoming proof. */
export function activeTokens(): string[] {
  pruneExpired();
  return [...issued.values()]
    .filter((token) => !token.redeemedBy)
    .map((token) => token.psk);
}

/** Drop the current code, e.g. when the user leaves the QR screen. */
export function revokeAll(): void {
  issued.clear();
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, token] of issued) {
    if (token.expiresAt < now) issued.delete(key);
  }
}

/**
 * PSKs held for codes *we scanned*, to send as a proof during our handshake
 * with that device. Keyed by the peer's deviceId.
 */
const scanned = new Map<string, { psk: string; expiresAt: number }>();

export function rememberScannedPsk(deviceId: string, psk: string, exp: number) {
  scanned.set(deviceId, { psk, expiresAt: exp });
}

export function scannedPsk(deviceId: string): string | null {
  const entry = scanned.get(deviceId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    scanned.delete(deviceId);
    return null;
  }
  return entry.psk;
}

export function forgetScannedPsk(deviceId: string): void {
  scanned.delete(deviceId);
}
