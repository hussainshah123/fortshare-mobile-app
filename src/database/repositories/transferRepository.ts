import {
  execute,
  fromSqlBoolNullable,
  query,
  queryOne,
  toSqlBool,
  transaction,
} from '../index';
import type {
  TransferDirection,
  TransferFileRecord,
  TransferFileStatus,
  TransferPauseReason,
  TransferRecord,
  TransferStatus,
} from '../../models/transfer';

interface TransferRow {
  id: string;
  deviceId: string;
  deviceName: string;
  direction: string;
  status: string;
  createdAt: number;
  completedAt: number | null;
  totalBytes: number;
  transferredBytes: number;
  fileCount: number;
  avgSpeed: number;
  durationMs: number;
  pauseReason: string | null;
  errorReason: string | null;
}

interface TransferFileRow {
  id: string;
  transferId: string;
  fileIndex: number;
  name: string;
  uri: string | null;
  destPath: string | null;
  size: number;
  mimeType: string;
  sha256: string | null;
  transferredBytes: number;
  status: string;
  verified: number | null;
  error: string | null;
  skipReason: string | null;
}

const toTransfer = (row: TransferRow): TransferRecord => ({
  id: row.id,
  deviceId: row.deviceId,
  deviceName: row.deviceName,
  direction: row.direction as TransferDirection,
  status: row.status as TransferStatus,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
  totalBytes: row.totalBytes,
  transferredBytes: row.transferredBytes,
  fileCount: row.fileCount,
  avgSpeed: row.avgSpeed,
  durationMs: row.durationMs,
  pauseReason: row.pauseReason as TransferPauseReason | null,
  errorReason: row.errorReason,
});

const toFile = (row: TransferFileRow): TransferFileRecord => ({
  id: row.id,
  transferId: row.transferId,
  fileIndex: row.fileIndex,
  name: row.name,
  uri: row.uri,
  destPath: row.destPath,
  size: row.size,
  mimeType: row.mimeType,
  sha256: row.sha256,
  transferredBytes: row.transferredBytes,
  status: row.status as TransferFileStatus,
  verified: fromSqlBoolNullable(row.verified),
  error: row.error,
  skipReason: (row.skipReason as TransferFileRecord['skipReason']) ?? null,
});

/** Statuses that can still be resumed. Used by the Active tab and resume sweep. */
const RESUMABLE = "('active','paused','pending','awaiting-approval')";

export const transferRepository = {
  /**
   * Persist a new transfer and its files atomically. Called before the first
   * byte moves, so an interrupted transfer is always recoverable from disk.
   */
  async create(
    record: TransferRecord,
    files: TransferFileRecord[],
  ): Promise<void> {
    await transaction(async (exec) => {
      await exec(
        `INSERT INTO transfers
           (id, deviceId, deviceName, direction, status, createdAt, completedAt,
            totalBytes, transferredBytes, fileCount, avgSpeed, durationMs,
            pauseReason, errorReason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.deviceId,
          record.deviceName,
          record.direction,
          record.status,
          record.createdAt,
          record.completedAt,
          record.totalBytes,
          record.transferredBytes,
          record.fileCount,
          record.avgSpeed,
          record.durationMs,
          record.pauseReason,
          record.errorReason,
        ],
      );
      for (const file of files) {
        await exec(
          `INSERT INTO transfer_files
             (id, transferId, fileIndex, name, uri, destPath, size, mimeType,
              sha256, transferredBytes, status, verified, error, skipReason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            file.id,
            file.transferId,
            file.fileIndex,
            file.name,
            file.uri,
            file.destPath,
            file.size,
            file.mimeType,
            file.sha256,
            file.transferredBytes,
            file.status,
            file.verified === null ? null : toSqlBool(file.verified),
            file.error,
            file.skipReason,
          ],
        );
      }
    });
  },

  async find(id: string): Promise<TransferRecord | null> {
    const row = await queryOne<TransferRow>(
      'SELECT * FROM transfers WHERE id = ?',
      [id],
    );
    return row ? toTransfer(row) : null;
  },

  async files(transferId: string): Promise<TransferFileRecord[]> {
    const rows = await query<TransferFileRow>(
      'SELECT * FROM transfer_files WHERE transferId = ? ORDER BY fileIndex ASC',
      [transferId],
    );
    return rows.map(toFile);
  },

  async findFile(fileId: string): Promise<TransferFileRecord | null> {
    const row = await queryOne<TransferFileRow>(
      'SELECT * FROM transfer_files WHERE id = ?',
      [fileId],
    );
    return row ? toFile(row) : null;
  },

  /** Newest first, paged. Backs the Transfers list. */
  async recent(limit = 50, offset = 0): Promise<TransferRecord[]> {
    const rows = await query<TransferRow>(
      'SELECT * FROM transfers ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(toTransfer);
  },

  async byDirection(
    direction: TransferDirection,
    limit = 50,
  ): Promise<TransferRecord[]> {
    const rows = await query<TransferRow>(
      `SELECT * FROM transfers WHERE direction = ?
        ORDER BY createdAt DESC LIMIT ?`,
      [direction, limit],
    );
    return rows.map(toTransfer);
  },

  async byStatus(
    statuses: TransferStatus[],
    limit = 50,
  ): Promise<TransferRecord[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = await query<TransferRow>(
      `SELECT * FROM transfers WHERE status IN (${placeholders})
        ORDER BY createdAt DESC LIMIT ?`,
      [...statuses, limit],
    );
    return rows.map(toTransfer);
  },

  async byDevice(deviceId: string, limit = 100): Promise<TransferRecord[]> {
    const rows = await query<TransferRow>(
      `SELECT * FROM transfers WHERE deviceId = ?
        ORDER BY createdAt DESC LIMIT ?`,
      [deviceId, limit],
    );
    return rows.map(toTransfer);
  },

  /**
   * Transfers that were still in flight when the app died. The resume sweep
   * on next launch reads this (§19: resume survives an app or phone restart).
   */
  async resumable(): Promise<TransferRecord[]> {
    const rows = await query<TransferRow>(
      `SELECT * FROM transfers WHERE status IN ${RESUMABLE}
        ORDER BY createdAt DESC`,
    );
    return rows.map(toTransfer);
  },

  async search(term: string, limit = 50): Promise<TransferRecord[]> {
    const rows = await query<TransferRow>(
      `SELECT DISTINCT t.* FROM transfers t
         LEFT JOIN transfer_files f ON f.transferId = t.id
        WHERE t.deviceName LIKE ? OR f.name LIKE ?
        ORDER BY t.createdAt DESC LIMIT ?`,
      [`%${term}%`, `%${term}%`, limit],
    );
    return rows.map(toTransfer);
  },

  /** Every completed received file, newest first. Backs the Files tab (§25). */
  async receivedFiles(limit = 200): Promise<
    (TransferFileRecord & { deviceName: string; receivedAt: number })[]
  > {
    const rows = await query<
      TransferFileRow & { deviceName: string; receivedAt: number }
    >(
      `SELECT f.*, t.deviceName AS deviceName,
              COALESCE(t.completedAt, t.createdAt) AS receivedAt
         FROM transfer_files f
         JOIN transfers t ON t.id = f.transferId
        WHERE t.direction = 'receive' AND f.status = 'completed'
        ORDER BY receivedAt DESC LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      ...toFile(row),
      deviceName: row.deviceName,
      receivedAt: row.receivedAt,
    }));
  },

  async updateStatus(
    id: string,
    status: TransferStatus,
    extra: {
      pauseReason?: TransferPauseReason | null;
      errorReason?: string | null;
      completedAt?: number | null;
      avgSpeed?: number;
      durationMs?: number;
    } = {},
  ): Promise<void> {
    await execute(
      `UPDATE transfers
          SET status = ?,
              pauseReason = COALESCE(?, pauseReason),
              errorReason = COALESCE(?, errorReason),
              completedAt = COALESCE(?, completedAt),
              avgSpeed    = COALESCE(?, avgSpeed),
              durationMs  = COALESCE(?, durationMs)
        WHERE id = ?`,
      [
        status,
        extra.pauseReason ?? null,
        extra.errorReason ?? null,
        extra.completedAt ?? null,
        extra.avgSpeed ?? null,
        extra.durationMs ?? null,
        id,
      ],
    );
  },

  /** Clears pauseReason/errorReason, which COALESCE above cannot do. */
  async clearFailureState(id: string): Promise<void> {
    await execute(
      'UPDATE transfers SET pauseReason = NULL, errorReason = NULL WHERE id = ?',
      [id],
    );
  },

  async updateProgress(id: string, transferredBytes: number): Promise<void> {
    await execute('UPDATE transfers SET transferredBytes = ? WHERE id = ?', [
      transferredBytes,
      id,
    ]);
  },

  async updateFileProgress(
    fileId: string,
    transferredBytes: number,
  ): Promise<void> {
    await execute(
      'UPDATE transfer_files SET transferredBytes = ? WHERE id = ?',
      [transferredBytes, fileId],
    );
  },

  async updateFile(
    fileId: string,
    patch: Partial<
      Pick<
        TransferFileRecord,
        | 'status'
        | 'transferredBytes'
        | 'verified'
        | 'error'
        | 'destPath'
        | 'sha256'
        | 'skipReason'
      >
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.transferredBytes !== undefined) {
      sets.push('transferredBytes = ?');
      params.push(patch.transferredBytes);
    }
    if (patch.verified !== undefined) {
      sets.push('verified = ?');
      params.push(patch.verified === null ? null : toSqlBool(patch.verified));
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.destPath !== undefined) {
      sets.push('destPath = ?');
      params.push(patch.destPath);
    }
    if (patch.sha256 !== undefined) {
      sets.push('sha256 = ?');
      params.push(patch.sha256);
    }
    if (patch.skipReason !== undefined) {
      sets.push('skipReason = ?');
      params.push(patch.skipReason);
    }
    if (sets.length === 0) return;
    params.push(fileId);
    await execute(
      `UPDATE transfer_files SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  },

  /**
   * Reconcile transfers that were in flight when the process died.
   *
   * A transfer still marked `active` at startup is impossible — nothing has
   * run yet — so it was interrupted by the app being closed or killed. Marked
   * `paused` so it becomes resumable and the UI stops claiming it is running.
   *
   * Returns how many were reconciled.
   */
  async markInterruptedAsPaused(): Promise<number> {
    return execute(
      `UPDATE transfers
          SET status = 'paused', pauseReason = 'network-lost'
        WHERE status IN ('active', 'pending', 'awaiting-approval')`,
    );
  },

  async remove(id: string): Promise<void> {
    await execute('DELETE FROM transfers WHERE id = ?', [id]);
  },

  async removeAll(): Promise<void> {
    await execute('DELETE FROM transfers');
  },

  /**
   * A previously received file with this exact content, if we have one.
   *
   * Content-addressed rather than name-based: re-sending a folder of photos
   * skips the ones already on the device even if they were renamed, which is
   * the case filename comparison misses entirely.
   */
  async findReceivedByDigest(
    sha256: string,
  ): Promise<{ name: string; destPath: string } | null> {
    if (!sha256) return null;
    const row = await queryOne<{ name: string; destPath: string | null }>(
      `SELECT f.name AS name, f.destPath AS destPath
         FROM transfer_files f
         JOIN transfers t ON t.id = f.transferId
        WHERE f.sha256 = ?
          AND f.status = 'completed'
          AND f.verified = 1
          AND t.direction = 'receive'
          AND f.destPath IS NOT NULL
        ORDER BY t.createdAt DESC
        LIMIT 1`,
      [sha256],
    );
    if (!row?.destPath) return null;
    return { name: row.name, destPath: row.destPath };
  },

  async totals(): Promise<{ transfers: number; bytes: number }> {
    const row = await queryOne<{ transfers: number; bytes: number | null }>(
      `SELECT COUNT(*) AS transfers, SUM(transferredBytes) AS bytes
         FROM transfers WHERE status = 'completed'`,
    );
    return { transfers: row?.transfers ?? 0, bytes: row?.bytes ?? 0 };
  },
};
