import { execute, queryOne } from '../index';

/**
 * Small JSON-valued settings that are not worth a column.
 *
 * Hot settings (device identity, theme) live in MMKV instead — see
 * services/storage.ts. This table is for things that should be queryable
 * alongside the rest of the relational data.
 */
export const settingsRepository = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await queryOne<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    );
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    await execute(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  },

  async remove(key: string): Promise<void> {
    await execute('DELETE FROM settings WHERE key = ?', [key]);
  },
};
