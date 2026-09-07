import { execute, fromSqlBool, query, queryOne, toSqlBool } from '../index';
import type {
  DeviceRecord,
  DiscoveredPeer,
  Platform,
  DeviceType,
} from '../../models/device';

interface DeviceRow {
  deviceId: string;
  name: string;
  platform: string;
  deviceType: string;
  avatar: string;
  firstConnectedAt: number;
  lastConnectedAt: number;
  lastSeenAt: number;
  lastKnownAddress: string | null;
  lastKnownPort: number | null;
  isFavorite: number;
  filesSent: number;
  filesReceived: number;
  bytesSent: number;
  bytesReceived: number;
}

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.deviceId,
    name: row.name,
    platform: row.platform as Platform,
    deviceType: row.deviceType as DeviceType,
    avatar: row.avatar,
    firstConnectedAt: row.firstConnectedAt,
    lastConnectedAt: row.lastConnectedAt,
    lastSeenAt: row.lastSeenAt,
    lastKnownAddress: row.lastKnownAddress,
    lastKnownPort: row.lastKnownPort,
    isFavorite: fromSqlBool(row.isFavorite),
    filesSent: row.filesSent,
    filesReceived: row.filesReceived,
    bytesSent: row.bytesSent,
    bytesReceived: row.bytesReceived,
  };
}

const SELECT = 'SELECT * FROM devices';

export const deviceRepository = {
  /** Favourites first, then most recently connected — the order every list wants. */
  async all(): Promise<DeviceRecord[]> {
    const rows = await query<DeviceRow>(
      `${SELECT} ORDER BY isFavorite DESC, lastConnectedAt DESC`,
    );
    return rows.map(toRecord);
  },

  async find(deviceId: string): Promise<DeviceRecord | null> {
    const row = await queryOne<DeviceRow>(
      `${SELECT} WHERE deviceId = ?`,
      [deviceId],
    );
    return row ? toRecord(row) : null;
  },

  async favorites(): Promise<DeviceRecord[]> {
    const rows = await query<DeviceRow>(
      `${SELECT} WHERE isFavorite = 1 ORDER BY lastConnectedAt DESC`,
    );
    return rows.map(toRecord);
  },

  async search(term: string): Promise<DeviceRecord[]> {
    const rows = await query<DeviceRow>(
      `${SELECT} WHERE name LIKE ? ORDER BY isFavorite DESC, lastConnectedAt DESC`,
      [`%${term}%`],
    );
    return rows.map(toRecord);
  },

  /**
   * Record a successful connection.
   *
   * Keyed on deviceId, so a peer that moved to a different IP updates its
   * existing row rather than creating a duplicate (§39). `firstConnectedAt`
   * is preserved across every later connection.
   */
  async upsertOnConnect(peer: {
    deviceId: string;
    deviceName: string;
    platform: Platform;
    deviceType: DeviceType;
    avatar?: string;
    host?: string | null;
    port?: number | null;
  }): Promise<DeviceRecord> {
    const now = Date.now();
    await execute(
      `INSERT INTO devices (
         deviceId, name, platform, deviceType, avatar,
         firstConnectedAt, lastConnectedAt, lastSeenAt,
         lastKnownAddress, lastKnownPort
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (deviceId) DO UPDATE SET
         name             = excluded.name,
         platform         = excluded.platform,
         deviceType       = excluded.deviceType,
         avatar           = CASE WHEN excluded.avatar != ''
                                 THEN excluded.avatar ELSE devices.avatar END,
         lastConnectedAt  = excluded.lastConnectedAt,
         lastSeenAt       = excluded.lastSeenAt,
         lastKnownAddress = excluded.lastKnownAddress,
         lastKnownPort    = excluded.lastKnownPort`,
      [
        peer.deviceId,
        peer.deviceName,
        peer.platform,
        peer.deviceType,
        peer.avatar ?? '',
        now,
        now,
        now,
        peer.host ?? null,
        peer.port ?? null,
      ],
    );
    const record = await this.find(peer.deviceId);
    if (!record) throw new Error(`device ${peer.deviceId} vanished after upsert`);
    return record;
  },

  /**
   * Refresh liveness and address from a discovery event.
   *
   * Deliberately does *not* insert: seeing a device on the network is not the
   * same as having connected to it, and history should only contain devices
   * we actually talked to (§9).
   */
  async touchFromDiscovery(peer: DiscoveredPeer): Promise<void> {
    await execute(
      `UPDATE devices
          SET lastSeenAt = ?, lastKnownAddress = ?, lastKnownPort = ?, name = ?
        WHERE deviceId = ?`,
      [Date.now(), peer.host, peer.port, peer.deviceName, peer.deviceId],
    );
  },

  async setFavorite(deviceId: string, isFavorite: boolean): Promise<void> {
    await execute('UPDATE devices SET isFavorite = ? WHERE deviceId = ?', [
      toSqlBool(isFavorite),
      deviceId,
    ]);
  },

  async rename(deviceId: string, name: string): Promise<void> {
    await execute('UPDATE devices SET name = ? WHERE deviceId = ?', [
      name,
      deviceId,
    ]);
  },

  /**
   * Fold a finished transfer into the device's running totals.
   *
   * Incremental rather than an aggregate over `transfers`, so the device list
   * stays instant however long history grows (§28).
   */
  async addTransferStats(
    deviceId: string,
    direction: 'send' | 'receive',
    files: number,
    bytes: number,
  ): Promise<void> {
    const sql =
      direction === 'send'
        ? `UPDATE devices
              SET filesSent = filesSent + ?, bytesSent = bytesSent + ?,
                  lastConnectedAt = ?
            WHERE deviceId = ?`
        : `UPDATE devices
              SET filesReceived = filesReceived + ?, bytesReceived = bytesReceived + ?,
                  lastConnectedAt = ?
            WHERE deviceId = ?`;
    await execute(sql, [files, bytes, Date.now(), deviceId]);
  },

  /** Removes the device and, by cascade, its pairing. Transfer history is kept. */
  async remove(deviceId: string): Promise<void> {
    await execute('DELETE FROM devices WHERE deviceId = ?', [deviceId]);
  },

  async aggregateStats(): Promise<{
    filesSent: number;
    filesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    deviceCount: number;
  }> {
    const row = await queryOne<{
      filesSent: number | null;
      filesReceived: number | null;
      bytesSent: number | null;
      bytesReceived: number | null;
      deviceCount: number;
    }>(
      `SELECT SUM(filesSent) AS filesSent, SUM(filesReceived) AS filesReceived,
              SUM(bytesSent) AS bytesSent, SUM(bytesReceived) AS bytesReceived,
              COUNT(*) AS deviceCount
         FROM devices`,
    );
    return {
      filesSent: row?.filesSent ?? 0,
      filesReceived: row?.filesReceived ?? 0,
      bytesSent: row?.bytesSent ?? 0,
      bytesReceived: row?.bytesReceived ?? 0,
      deviceCount: row?.deviceCount ?? 0,
    };
  },
};
