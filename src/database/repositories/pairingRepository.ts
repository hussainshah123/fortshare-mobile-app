import { execute, fromSqlBool, queryOne, query, toSqlBool } from '../index';
import type { PairingMethod, PairingRecord } from '../../models/device';

interface PairingRow {
  deviceId: string;
  edPublicKey: string;
  xPublicKey: string;
  fingerprint: string;
  pairedAt: number;
  method: string;
  trusted: number;
  revokedAt: number | null;
}

const toRecord = (row: PairingRow): PairingRecord => ({
  deviceId: row.deviceId,
  edPublicKey: row.edPublicKey,
  xPublicKey: row.xPublicKey,
  fingerprint: row.fingerprint,
  pairedAt: row.pairedAt,
  method: row.method as PairingMethod,
  trusted: fromSqlBool(row.trusted),
  revokedAt: row.revokedAt,
});

/**
 * Pinned peer identities.
 *
 * The *key* stored here — not the deviceId — is what authenticates a peer. A
 * deviceId is public (it is in every mDNS TXT record); only the matching
 * Ed25519 key proves ownership of it.
 */
export const pairingRepository = {
  async find(deviceId: string): Promise<PairingRecord | null> {
    const row = await queryOne<PairingRow>(
      'SELECT * FROM pairings WHERE deviceId = ?',
      [deviceId],
    );
    return row ? toRecord(row) : null;
  },

  async all(): Promise<PairingRecord[]> {
    const rows = await query<PairingRow>(
      'SELECT * FROM pairings ORDER BY pairedAt DESC',
    );
    return rows.map(toRecord);
  },

  /**
   * Pin a peer's keys. Replaces any previous pairing for the same deviceId,
   * so an explicit re-pair after a reinstall works — but note that this is
   * only ever reached with user consent or a valid QR proof. The handshake
   * never calls it to paper over a key mismatch.
   */
  async pin(pairing: Omit<PairingRecord, 'revokedAt'>): Promise<void> {
    await execute(
      `INSERT INTO pairings
         (deviceId, edPublicKey, xPublicKey, fingerprint, pairedAt, method, trusted, revokedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (deviceId) DO UPDATE SET
         edPublicKey = excluded.edPublicKey,
         xPublicKey  = excluded.xPublicKey,
         fingerprint = excluded.fingerprint,
         pairedAt    = excluded.pairedAt,
         method      = excluded.method,
         trusted     = excluded.trusted,
         revokedAt   = NULL`,
      [
        pairing.deviceId,
        pairing.edPublicKey,
        pairing.xPublicKey,
        pairing.fingerprint,
        pairing.pairedAt,
        pairing.method,
        toSqlBool(pairing.trusted),
      ],
    );
  },

  /** Withdraw trust without forgetting that the pairing existed. */
  async revoke(deviceId: string): Promise<void> {
    await execute(
      'UPDATE pairings SET trusted = 0, revokedAt = ? WHERE deviceId = ?',
      [Date.now(), deviceId],
    );
  },

  async remove(deviceId: string): Promise<void> {
    await execute('DELETE FROM pairings WHERE deviceId = ?', [deviceId]);
  },
};
