export type TransferDirection = 'send' | 'receive';

export type TransferStatus =
  | 'pending'
  | 'awaiting-approval'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TransferFileStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Why a transfer stopped. Surfaced verbatim in the UI so users can act on it. */
export type TransferPauseReason =
  | 'user'
  | 'peer'
  | 'network-lost'
  | 'peer-unreachable'
  | 'timeout'
  | 'error';

/** What to do when the incoming filename already exists at the destination. */
export type DuplicateResolution = 'replace' | 'keep-both' | 'skip';

export interface TransferRecord {
  id: string;
  deviceId: string;
  /** Denormalised so history renders without a join even if the device is gone. */
  deviceName: string;
  direction: TransferDirection;
  status: TransferStatus;
  createdAt: number;
  completedAt: number | null;
  totalBytes: number;
  transferredBytes: number;
  fileCount: number;
  /** Bytes/sec averaged over the whole transfer. */
  avgSpeed: number;
  durationMs: number;
  pauseReason: TransferPauseReason | null;
  errorReason: string | null;
}

export interface TransferFileRecord {
  id: string;
  transferId: string;
  /** Position in the transfer. Also the `fileIndex` on the wire. */
  fileIndex: number;
  name: string;
  /** Source URI on the sender. Null on the receiver. */
  uri: string | null;
  /** Final on-disk path on the receiver. Null on the sender. */
  destPath: string | null;
  size: number;
  mimeType: string;
  /** SHA-256, hex. Computed before sending; verified after receiving. */
  sha256: string | null;
  transferredBytes: number;
  status: TransferFileStatus;
  /** null = not yet checked, true = digest matched, false = mismatch. */
  verified: boolean | null;
  error: string | null;
}

/** Live, in-memory view of a running transfer. Not persisted every tick. */
export interface ActiveTransfer {
  record: TransferRecord;
  files: TransferFileRecord[];
  currentFileIndex: number;
  /** EWMA over a 2s window, bytes/sec. */
  speed: number;
  /** Seconds remaining, or null while speed is still unknown. */
  etaSeconds: number | null;
  filesCompleted: number;
}

/** A file the user picked, before it becomes a TransferFileRecord. */
export interface SelectedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  /** Populated for images/videos so the picker can show a thumbnail. */
  thumbnailUri?: string;
}

export type FileCategory =
  | 'photos'
  | 'videos'
  | 'music'
  | 'documents'
  | 'apk'
  | 'archives'
  | 'other'
  | 'folders';
