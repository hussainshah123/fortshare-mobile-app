import { create } from 'zustand';
import { transferRepository } from '../database/repositories';
import { TransferEngine } from '../network/transfer/TransferEngine';
import { SessionManager } from '../network/session/SessionManager';
import { memoizeSelector } from './memo';
import type {
  ActiveTransfer,
  TransferFileRecord,
  TransferRecord,
} from '../models/transfer';

export type HistoryFilter = 'all' | 'sent' | 'received' | 'failed';

export interface ReceivedFile extends TransferFileRecord {
  deviceName: string;
  receivedAt: number;
}

interface TransferState {
  /** Live transfers, keyed by transferId. Replaced wholesale on each event. */
  active: Map<string, ActiveTransfer>;
  history: TransferRecord[];
  received: ReceivedFile[];
  loading: boolean;
  /** Set while hashing files before an offer, so the UI can say "Preparing". */
  preparing: { done: number; total: number } | null;

  applyActive: (transfer: ActiveTransfer) => void;
  refreshHistory: () => Promise<void>;
  refreshReceived: () => Promise<void>;
  setPreparing: (progress: { done: number; total: number } | null) => void;

  pause: (transferId: string) => Promise<void>;
  resume: (transferId: string) => Promise<void>;
  cancel: (transferId: string) => Promise<void>;
  deleteHistory: (transferId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  active: new Map(),
  history: [],
  received: [],
  loading: true,
  preparing: null,

  /**
   * Fold one engine event into the live map.
   *
   * A transfer that has reached a terminal state is dropped from `active` and
   * history is reloaded, so it appears in the Completed/Failed tab without the
   * screen having to poll.
   */
  applyActive: (transfer) => {
    const terminal =
      transfer.record.status === 'completed' ||
      transfer.record.status === 'failed' ||
      transfer.record.status === 'cancelled';

    set((state) => {
      const next = new Map(state.active);
      if (terminal) next.delete(transfer.record.id);
      else next.set(transfer.record.id, transfer);
      return { active: next };
    });

    if (terminal) {
      void get().refreshHistory();
      if (transfer.record.direction === 'receive') {
        void get().refreshReceived();
      }
    }
  },

  refreshHistory: async () => {
    const history = await transferRepository.recent(200);
    set({ history, loading: false });
  },

  refreshReceived: async () => {
    const received = await transferRepository.receivedFiles(300);
    set({ received });
  },

  setPreparing: (preparing) => set({ preparing }),

  pause: async (transferId) => {
    await TransferEngine.pause(transferId);
  },

  resume: async (transferId) => {
    await TransferEngine.resume(transferId);
  },

  cancel: async (transferId) => {
    await TransferEngine.cancel(transferId);
    await get().refreshHistory();
  },

  deleteHistory: async (transferId) => {
    await transferRepository.remove(transferId);
    await Promise.all([get().refreshHistory(), get().refreshReceived()]);
  },

  clearHistory: async () => {
    await transferRepository.removeAll();
    await Promise.all([get().refreshHistory(), get().refreshReceived()]);
  },
}));

// ---------------------------------------------------------------- selectors
//
// Every selector below derives a new array or object, and zustand reads them
// through `useSyncExternalStore` — so each one is memoised on its inputs.
// See store/memo.ts for why an uncached derivation loops forever.

const buildActive = memoizeSelector((active: Map<string, ActiveTransfer>) =>
  [...active.values()].sort((a, b) => b.record.createdAt - a.record.createdAt),
);

export function activeTransfers(state: TransferState): ActiveTransfer[] {
  return buildActive(state.active);
}

/**
 * The one transfer worth showing on Home, if any.
 *
 * Returns an element of the memoised list, so its reference is stable.
 */
export function primaryTransfer(state: TransferState): ActiveTransfer | null {
  const running = activeTransfers(state);
  return running.find((t) => t.record.status === 'active') ?? running[0] ?? null;
}

const applyFilter = memoizeSelector(
  (history: TransferRecord[], filter: HistoryFilter): TransferRecord[] => {
    switch (filter) {
      case 'sent':
        return history.filter((t) => t.direction === 'send');
      case 'received':
        return history.filter((t) => t.direction === 'receive');
      case 'failed':
        return history.filter(
          (t) => t.status === 'failed' || t.status === 'cancelled',
        );
      case 'all':
        return history;
      default:
        return history;
    }
  },
);

export function filteredHistory(
  state: TransferState,
  filter: HistoryFilter,
): TransferRecord[] {
  return applyFilter(state.history, filter);
}

const countByFilter = memoizeSelector((history: TransferRecord[]) => ({
  all: history.length,
  sent: history.filter((t) => t.direction === 'send').length,
  received: history.filter((t) => t.direction === 'receive').length,
  failed: history.filter(
    (t) => t.status === 'failed' || t.status === 'cancelled',
  ).length,
}));

/** Tab badge counts for the Transfers screen. */
export function historyCounts(state: TransferState): {
  all: number;
  sent: number;
  received: number;
  failed: number;
} {
  return countByFilter(state.history);
}

/**
 * Transfers that stopped part-way and can still be picked up (§19).
 *
 * `canResume` reflects whether the peer is reachable *right now*. Reachability
 * is not part of this store, so this is read on demand rather than subscribed
 * to — call it from an event handler, not as a render-time selector.
 */
export function resumableTransfers(
  state: TransferState,
): { record: TransferRecord; canResume: boolean }[] {
  return state.history
    .filter((record) => record.status === 'paused')
    .map((record) => ({
      record,
      canResume: SessionManager.isConnected(record.deviceId),
    }));
}

const computeStats = memoizeSelector((history: TransferRecord[]) => {
  let filesSent = 0;
  let filesReceived = 0;
  let bytesTransferred = 0;

  for (const record of history) {
    if (record.status !== 'completed') continue;
    bytesTransferred += record.transferredBytes;
    if (record.direction === 'send') filesSent += record.fileCount;
    else filesReceived += record.fileCount;
  }

  return { filesSent, filesReceived, bytesTransferred };
});

export function transferStats(state: TransferState): {
  filesSent: number;
  filesReceived: number;
  bytesTransferred: number;
} {
  return computeStats(state.history);
}
