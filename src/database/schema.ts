/**
 * SQLite schema and forward-only migrations.
 *
 * Nothing here has a remote counterpart: there is no sync, no account and no
 * cloud. Every row was written by this device and is only ever read by it.
 *
 * To change the schema, append a new entry to MIGRATIONS. Never edit an
 * existing one — installed apps have already run it.
 */

export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'devices, pairings, transfers, transfer_files, settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS devices (
         deviceId          TEXT PRIMARY KEY NOT NULL,
         name              TEXT NOT NULL,
         platform          TEXT NOT NULL,
         deviceType        TEXT NOT NULL,
         avatar            TEXT NOT NULL DEFAULT '',
         firstConnectedAt  INTEGER NOT NULL,
         lastConnectedAt   INTEGER NOT NULL,
         lastSeenAt        INTEGER NOT NULL,
         -- Cache to speed up reconnects. Never used to decide identity:
         -- a DHCP change must not create a second row.
         lastKnownAddress  TEXT,
         lastKnownPort     INTEGER,
         isFavorite        INTEGER NOT NULL DEFAULT 0,
         filesSent         INTEGER NOT NULL DEFAULT 0,
         filesReceived     INTEGER NOT NULL DEFAULT 0,
         bytesSent         INTEGER NOT NULL DEFAULT 0,
         bytesReceived     INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_devices_favorite
         ON devices (isFavorite DESC, lastConnectedAt DESC)`,

      // A row here with a *matching* public key is what allows a silent
      // reconnect. A mismatch is a security event, not a stale cache.
      `CREATE TABLE IF NOT EXISTS pairings (
         deviceId      TEXT PRIMARY KEY NOT NULL,
         edPublicKey   TEXT NOT NULL,
         xPublicKey    TEXT NOT NULL,
         fingerprint   TEXT NOT NULL,
         pairedAt      INTEGER NOT NULL,
         method        TEXT NOT NULL,
         trusted       INTEGER NOT NULL DEFAULT 1,
         revokedAt     INTEGER,
         FOREIGN KEY (deviceId) REFERENCES devices (deviceId) ON DELETE CASCADE
       )`,

      `CREATE TABLE IF NOT EXISTS transfers (
         id                TEXT PRIMARY KEY NOT NULL,
         deviceId          TEXT NOT NULL,
         -- Denormalised so history still renders after a device is removed.
         deviceName        TEXT NOT NULL,
         direction         TEXT NOT NULL,
         status            TEXT NOT NULL,
         createdAt         INTEGER NOT NULL,
         completedAt       INTEGER,
         totalBytes        INTEGER NOT NULL DEFAULT 0,
         transferredBytes  INTEGER NOT NULL DEFAULT 0,
         fileCount         INTEGER NOT NULL DEFAULT 0,
         avgSpeed          REAL NOT NULL DEFAULT 0,
         durationMs        INTEGER NOT NULL DEFAULT 0,
         pauseReason       TEXT,
         errorReason       TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_transfers_created
         ON transfers (createdAt DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_transfers_device
         ON transfers (deviceId, createdAt DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_transfers_status
         ON transfers (status, createdAt DESC)`,

      // transferredBytes + sha256 + size here are what make resume survive an
      // app or phone restart, alongside the .fortshare-part file on disk.
      `CREATE TABLE IF NOT EXISTS transfer_files (
         id                TEXT PRIMARY KEY NOT NULL,
         transferId        TEXT NOT NULL,
         fileIndex         INTEGER NOT NULL,
         name              TEXT NOT NULL,
         uri               TEXT,
         destPath          TEXT,
         size              INTEGER NOT NULL,
         mimeType          TEXT NOT NULL,
         sha256            TEXT,
         transferredBytes  INTEGER NOT NULL DEFAULT 0,
         status            TEXT NOT NULL,
         verified          INTEGER,
         error             TEXT,
         FOREIGN KEY (transferId) REFERENCES transfers (id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_transfer_files_transfer
         ON transfer_files (transferId, fileIndex)`,

      `CREATE TABLE IF NOT EXISTS settings (
         key    TEXT PRIMARY KEY NOT NULL,
         value  TEXT NOT NULL
       )`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
