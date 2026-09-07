import { open, type DB, type Scalar } from '@op-engineering/op-sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

const DB_NAME = 'fortshare.sqlite';

let db: DB | null = null;
let ready: Promise<DB> | null = null;

/**
 * Open the database and bring it up to SCHEMA_VERSION.
 *
 * Concurrent callers share one promise, so a cold start that touches several
 * repositories at once still runs migrations exactly once.
 */
export function initDatabase(): Promise<DB> {
  if (ready) return ready;
  ready = (async () => {
    const handle = open({ name: DB_NAME });

    await handle.execute('PRAGMA journal_mode = WAL');
    await handle.execute('PRAGMA foreign_keys = ON');
    // Durable enough for a phone; avoids an fsync per statement while a
    // transfer is writing progress rows several times a second.
    await handle.execute('PRAGMA synchronous = NORMAL');

    const current = await currentVersion(handle);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await handle.transaction(async (tx) => {
        for (const statement of migration.statements) {
          await tx.execute(statement);
        }
      });
      await handle.execute(`PRAGMA user_version = ${migration.version}`);
    }

    db = handle;
    return handle;
  })();
  return ready;
}

async function currentVersion(handle: DB): Promise<number> {
  const result = await handle.execute('PRAGMA user_version');
  const row = result.rows[0];
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

/**
 * The open handle. Throws rather than lazily opening, because a silent open
 * here would race the migrations above.
 */
export function database(): DB {
  if (!db) {
    throw new Error('Database used before initDatabase() resolved');
  }
  return db;
}

/** Run a query and return typed rows. */
export async function query<T>(sql: string, params: Scalar[] = []): Promise<T[]> {
  const result = await database().execute(sql, params);
  return result.rows as T[];
}

/** Run a query expected to return at most one row. */
export async function queryOne<T>(
  sql: string,
  params: Scalar[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run a statement, returning the number of rows it changed. */
export async function execute(
  sql: string,
  params: Scalar[] = [],
): Promise<number> {
  const result = await database().execute(sql, params);
  return result.rowsAffected;
}

/** Run several statements atomically. */
export async function transaction(
  work: (exec: (sql: string, params?: Scalar[]) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  await database().transaction(async (tx) => {
    await work((sql, params) => tx.execute(sql, params ?? []));
  });
}

/** SQLite has no boolean type; these keep the 0/1 mapping in one place. */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0);
export const fromSqlBool = (value: Scalar | undefined): boolean => value === 1;
export const fromSqlBoolNullable = (
  value: Scalar | undefined,
): boolean | null => (value === null || value === undefined ? null : value === 1);

export { SCHEMA_VERSION };
