import {
  deviceRepository,
  pairingRepository,
} from '../../database/repositories';
import type {
  DeviceType,
  PairingMethod,
  Platform,
} from '../../models/device';
import { fingerprintOf } from '../../services/crypto';

/**
 * The trust decision (§15, §42).
 *
 * Being on the same Wi-Fi grants a peer exactly one privilege: the right to
 * ask. Everything else has to be earned by holding a key we have already
 * pinned, or by proving possession of a QR code, or by the user tapping
 * Accept.
 */

export type TrustDecision =
  /** Known peer, key matches what we pinned. Connect silently — this is §45. */
  | { kind: 'trusted'; method: PairingMethod }
  /**
   * A peer is claiming a deviceId we have pinned, but presenting a different
   * key. Either an impersonation attempt or a reinstall. Never silently
   * accepted: the user has to re-pair deliberately.
   */
  | { kind: 'key-mismatch'; storedFingerprint: string; presentedFingerprint: string }
  /** Trust was explicitly withdrawn. Treated as unknown, but worth saying so. */
  | { kind: 'revoked' }
  /** Never seen before. Requires a QR proof or an explicit Accept. */
  | { kind: 'unknown' };

/**
 * Decide how much to trust a peer, given the identity it presented in HELLO.
 *
 * Note what this function does *not* do: it never writes. Pinning only ever
 * happens through {@link pinTrust}, which is reached from an explicit user
 * decision or a verified QR proof — never from this function papering over a
 * mismatch.
 */
export async function evaluateTrust(
  deviceId: string,
  presentedEdPub: string,
): Promise<TrustDecision> {
  const pairing = await pairingRepository.find(deviceId);
  if (!pairing) return { kind: 'unknown' };

  if (pairing.edPublicKey !== presentedEdPub) {
    return {
      kind: 'key-mismatch',
      storedFingerprint: pairing.fingerprint,
      presentedFingerprint: fingerprintOf(presentedEdPub),
    };
  }

  if (!pairing.trusted || pairing.revokedAt !== null) {
    return { kind: 'revoked' };
  }

  return { kind: 'trusted', method: pairing.method };
}

/**
 * Pin a peer's keys.
 *
 * Only three callers are legitimate:
 *   - the user tapped Accept on a pairing request  (method: 'manual')
 *   - a valid, unexpired, unredeemed QR proof verified (method: 'qr')
 *   - the user initiated the connection to a device they picked themselves,
 *     and the handshake signature verified                (method: 'auto')
 *
 * Records the device *before* the pairing. `pairings.deviceId` is a foreign
 * key into `devices` and `PRAGMA foreign_keys` is ON, so pinning a key for a
 * device with no row fails the constraint — which previously surfaced during
 * the handshake as a misleading "bad signature".
 */
export async function pinTrust(params: {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  deviceType: DeviceType;
  edPublicKey: string;
  xPublicKey: string;
  method: PairingMethod;
}): Promise<void> {
  // The user (or a QR proof) has authorised this peer, so it belongs in
  // history. SessionManager.promote() upserts again once the session is up,
  // adding the address and refreshing lastConnectedAt; firstConnectedAt is
  // preserved by the upsert.
  await deviceRepository.upsertOnConnect({
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    platform: params.platform,
    deviceType: params.deviceType,
  });

  await pairingRepository.pin({
    deviceId: params.deviceId,
    edPublicKey: params.edPublicKey,
    xPublicKey: params.xPublicKey,
    fingerprint: fingerprintOf(params.edPublicKey),
    pairedAt: Date.now(),
    method: params.method,
    trusted: true,
  });
}

export async function revokeTrust(deviceId: string): Promise<void> {
  await pairingRepository.revoke(deviceId);
}

/** Used by the device list to show whether a history entry is still paired. */
export async function pairedDeviceIds(): Promise<Set<string>> {
  const pairings = await pairingRepository.all();
  return new Set(
    pairings
      .filter((pairing) => pairing.trusted && pairing.revokedAt === null)
      .map((pairing) => pairing.deviceId),
  );
}
