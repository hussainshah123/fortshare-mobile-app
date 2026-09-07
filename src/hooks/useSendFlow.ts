import { useCallback, useState } from 'react';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { SessionManager, type PeerSession } from '../network/session/SessionManager';
import { TransferEngine } from '../network/transfer/TransferEngine';
import { useDeviceStore, useTransferStore, useUiStore } from '../store';
import type { SelectedFile } from '../models/transfer';

/**
 * The one-tap send path (§11, §45).
 *
 * "Devices → Samsung S25 → Send Files" has to work without re-pairing, so this
 * hook does exactly what §11 lays out:
 *
 *   1. is the device reachable right now?
 *   2. if so, reuse or establish the trusted local connection
 *   3. pick files
 *   4. confirm
 *   5. transfer
 *
 * Steps 3 and 4 are screens; this hook owns 1, 2 and 5, and is the only place
 * that knows a session has to exist before an offer can be made.
 */
export function useSendFlow() {
  const [connecting, setConnecting] = useState(false);
  const toast = useUiStore((state) => state.toast);
  const setConnectingFlag = useDeviceStore((state) => state.setConnecting);

  /**
   * Get a live session for a device, dialling if necessary.
   *
   * Returns null (having explained why) rather than throwing, so callers can
   * simply not navigate onwards.
   */
  const ensureSession = useCallback(
    async (deviceId: string, deviceName: string): Promise<PeerSession | null> => {
      const existing = SessionManager.session(deviceId);
      if (existing) return existing;

      const peer = DiscoveryService.peer(deviceId);
      if (!peer) {
        // §12: the historical record stays; the device is simply not here.
        toast(`${deviceName} is not on this network right now`, 'error');
        return null;
      }

      setConnecting(true);
      setConnectingFlag(deviceId, true);
      try {
        return await SessionManager.connect(peer);
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : `Could not connect to ${deviceName}`,
          'error',
        );
        return null;
      } finally {
        setConnecting(false);
        setConnectingFlag(deviceId, false);
      }
    },
    [toast, setConnectingFlag],
  );

  /**
   * Hash, offer and start streaming.
   *
   * Hashing happens before the offer so the receiver can verify what it gets
   * (§18), which for large files takes a moment — hence the "Preparing" state
   * rather than a silent pause.
   */
  const send = useCallback(
    async (
      deviceId: string,
      deviceName: string,
      files: SelectedFile[],
    ): Promise<string | null> => {
      const session = await ensureSession(deviceId, deviceName);
      if (!session) return null;

      const store = useTransferStore.getState();
      store.setPreparing({ done: 0, total: files.length });
      try {
        const transferId = await TransferEngine.send(session, files, (done, total) =>
          store.setPreparing({ done, total }),
        );
        return transferId;
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'Could not start the transfer',
          'error',
        );
        return null;
      } finally {
        store.setPreparing(null);
      }
    },
    [ensureSession, toast],
  );

  return { ensureSession, send, connecting };
}
