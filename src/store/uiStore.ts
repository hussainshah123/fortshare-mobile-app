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
  resolve: (result: ApprovalResult) => void;
}

/**
 * The answer to an incoming transfer offer.
 *
 * Carries a reason rather than a bare boolean because the reason travels to
 * the *other* device and is shown to that user. Reporting "declined by the
 * user" when nobody declined — because a prompt happened to be open, say —
 * sends the sender chasing the wrong problem entirely.
 */
export type ApprovalResult =
  | { accepted: true }
  | { accepted: false; reason: string };

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
  ) => Promise<ApprovalResult>;
  answerTransferApproval: (accepted: boolean) => void;
  /**
   * Abandon any prompt belonging to a device, answering it negatively.
   *
   * Without this a prompt whose session died stayed on screen and, worse,
   * stayed in state — and because a pending prompt blocks the next one, every
   * subsequent transfer from anyone was auto-declined for the rest of the
   * app's life.
   */
  cancelPromptsForDevice: (deviceId: string, reason: string) => void;

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
    new Promise<ApprovalResult>((resolve) => {
      const open = get().transferPrompt;
      if (open) {
        // Two devices offering at once. Honest about which it is: the sender
        // is told the receiver is busy, not that it was refused.
        resolve({
          accepted: false,
          reason: `${open.session.peer.deviceName} is already asking to send files — try again in a moment`,
        });
        return;
      }
      set({ transferPrompt: { session, offer, resolve } });
    }),

  answerTransferApproval: (accepted) => {
    const prompt = get().transferPrompt;
    if (!prompt) return;
    set({ transferPrompt: null });
    prompt.resolve(
      accepted ? { accepted: true } : { accepted: false, reason: 'declined by the user' },
    );
  },

  cancelPromptsForDevice: (deviceId, reason) => {
    const transfer = get().transferPrompt;
    if (transfer && transfer.session.peer.deviceId === deviceId) {
      set({ transferPrompt: null });
      transfer.resolve({ accepted: false, reason });
    }

    const pairing = get().pairingPrompt;
    if (pairing && pairing.peer.deviceId === deviceId) {
      set({ pairingPrompt: null });
      pairing.resolve(false);
    }
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
