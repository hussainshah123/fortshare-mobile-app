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

      /**
       * No network at all — refuse immediately.
       *
       * Without this the connect attempt runs to a full 10-second timeout and
       * fails with ENETUNREACH, which reads as "that device is unreachable"
       * when the real problem is on this device.
       *
       * Having discovered a peer overrides this, because it is proof of a
       * usable link that no address can show: an iPhone sharing over AWDL has
       * no IPv4 address of its own, and is dialled through its Bonjour
       * endpoint rather than by address. Refusing there blocked the one route
       * that works with no Wi-Fi network at all.
       */
      const discovery = DiscoveryService.state();
      if (
        !discovery.networkAvailable &&
        !discovery.wifiDirect.connected &&
        discovery.peers.size === 0
      ) {
        toast(
          'This device has no Wi-Fi connection. Turn Wi-Fi on — no internet is needed.',
          'error',
        );
        return null;
      }

      let peer = DiscoveryService.peer(deviceId);

      /**
       * Not on this network — but possibly still reachable.
       *
       * When the two devices are on different Wi-Fi networks, mDNS finds
       * nothing: multicast does not cross networks. Wi-Fi Direct does not care
       * about networks at all, only radio range, so it is worth trying before
       * declaring the device unreachable. Previously this gave up here, which
       * meant the whole Wi-Fi Direct path was unreachable from the one screen
       * a user would actually use it from.
       */
      if (!peer && DiscoveryService.canReachViaWifiDirect(deviceId)) {
        toast(
          `Connecting to ${deviceName} directly — accept the invitation on that device`,
        );
        setConnecting(true);
        setConnectingFlag(deviceId, true);
        try {
          peer = await DiscoveryService.openWifiDirectRoute(deviceId);
        } catch (error) {
          toast(
            error instanceof Error
              ? error.message
              : `Could not open a direct connection to ${deviceName}`,
            'error',
          );
          return null;
        } finally {
          setConnecting(false);
          setConnectingFlag(deviceId, false);
        }
      }

      if (!peer) {
        // §12: the historical record stays; the device is simply not here.
        //
        // If Wi-Fi Direct could help but is switched off, say so — "not on
        // this network" is true but unhelpful when there is a way around it.
        if (
          !DiscoveryService.isWifiDirectEnabled() &&
          DiscoveryService.isWifiDirectAvailable()
        ) {
          toast(
            `${deviceName} is not on this Wi-Fi. Turn on Wi-Fi Direct in Devices to connect without a shared network.`,
            'error',
          );
        } else {
          toast(`${deviceName} is not reachable right now`, 'error');
        }
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
