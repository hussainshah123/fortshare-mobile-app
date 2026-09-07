import { create } from 'zustand';
import type { HandshakePeer } from '../network/pairing/handshake';
import type { PeerSession } from '../network/session/SessionManager';
import type { TransferOfferMessage } from '../models/protocol';
import type { DuplicateResolution } from '../models/transfer';

/**
 * Prompts the networking layer needs a human answer to.
 *
 * Each one is a promise the network layer is blocked on, paired with the
 * resolver the UI calls. Keeping the resolvers here means the handshake and
 * transfer engines can `await` a user decision without knowing anything about
 * React.
 */

export interface PairingPrompt {
  peer: HandshakePeer;
  resolve: (accepted: boolean) => void;
}

export interface TransferPrompt {
  session: PeerSession;
  offer: TransferOfferMessage;
  resolve: (accepted: boolean) => void;
}

export interface DuplicatePrompt {
  fileName: string;
  size: number;
  resolve: (resolution: DuplicateResolution) => void;
}

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

interface UiState {
  pairingPrompt: PairingPrompt | null;
  transferPrompt: TransferPrompt | null;
  duplicatePrompt: DuplicatePrompt | null;
  toasts: Toast[];

  /** Blocks until the user answers. Resolves false if a prompt is already up. */
  requestPairing: (peer: HandshakePeer) => Promise<boolean>;
  answerPairing: (accepted: boolean) => void;

  requestTransferApproval: (
    session: PeerSession,
    offer: TransferOfferMessage,
  ) => Promise<boolean>;
  answerTransferApproval: (accepted: boolean) => void;

  requestDuplicateResolution: (
    fileName: string,
    size: number,
  ) => Promise<DuplicateResolution>;
  answerDuplicateResolution: (resolution: DuplicateResolution) => void;

  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
}

let toastCounter = 0;

export const useUiStore = create<UiState>((set, get) => ({
  pairingPrompt: null,
  transferPrompt: null,
  duplicatePrompt: null,
  toasts: [],

  requestPairing: (peer) =>
    new Promise<boolean>((resolve) => {
      // Two devices dialling us at once must not silently overwrite each
      // other's prompt: the second is declined rather than lost.
      if (get().pairingPrompt) {
        resolve(false);
        return;
      }
      set({ pairingPrompt: { peer, resolve } });
    }),

  answerPairing: (accepted) => {
    const prompt = get().pairingPrompt;
    if (!prompt) return;
    set({ pairingPrompt: null });
    prompt.resolve(accepted);
  },

  requestTransferApproval: (session, offer) =>
    new Promise<boolean>((resolve) => {
      if (get().transferPrompt) {
        resolve(false);
        return;
      }
      set({ transferPrompt: { session, offer, resolve } });
    }),

  answerTransferApproval: (accepted) => {
    const prompt = get().transferPrompt;
    if (!prompt) return;
    set({ transferPrompt: null });
    prompt.resolve(accepted);
  },

  requestDuplicateResolution: (fileName, size) =>
    new Promise<DuplicateResolution>((resolve) => {
      // A multi-file transfer asks once per collision, in sequence. If one is
      // somehow already open, fall back to the non-destructive answer.
      if (get().duplicatePrompt) {
        resolve('keep-both');
        return;
      }
      set({ duplicatePrompt: { fileName, size, resolve } });
    }),

  answerDuplicateResolution: (resolution) => {
    const prompt = get().duplicatePrompt;
    if (!prompt) return;
    set({ duplicatePrompt: null });
    prompt.resolve(resolution);
  },

  toast: (message, tone = 'info') => {
    toastCounter += 1;
    const id = `t${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), 3600);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
