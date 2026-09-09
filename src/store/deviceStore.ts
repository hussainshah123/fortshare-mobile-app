import { create } from 'zustand';
import { deviceRepository } from '../database/repositories';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { memoizeSelector } from './memo';
import { SessionManager } from '../network/session/SessionManager';
import { pairedDeviceIds } from '../network/pairing/trust';
import type {
  DeviceListItem,
  DeviceRecord,
  DeviceStatus,
  DiscoveredPeer,
} from '../models/device';

interface DeviceState {
  /** Persisted history. Never pruned for being offline. */
  history: DeviceRecord[];
  /** Peers visible on the network right now, keyed by deviceId. */
  peers: Map<string, DiscoveredPeer>;
  /** deviceIds whose keys we have pinned. */
  paired: Set<string>;
  /** deviceIds we are mid-handshake with, for the "Connecting…" state. */
  connecting: Set<string>;
  /**
   * deviceIds we currently hold a live session with.
   *
   * Tracked separately from discovery because it is *stronger* evidence of
   * reachability: mDNS says a device announced itself, a session says we are
   * connected to it right now. A QR pairing produces a session without any
   * mDNS announcement at all, and treating that device as offline hid the
   * Send Files button on a device we were actively talking to.
   */
  connected: Set<string>;

  networkAvailable: boolean;
  localAddress: string;
  discovering: boolean;
  discoveryError: string | null;
  loading: boolean;
  /** Wi-Fi Direct: opt-in, and the only path that bypasses the router. */
  wifiDirect: {
    enabled: boolean;
    connected: boolean;
    supported: boolean;
    unsupportedReason: string;
    message: string | null;
  };

  refreshHistory: () => Promise<void>;
  applyDiscovery: (state: {
    peers: Map<string, DiscoveredPeer>;
    networkAvailable: boolean;
    localAddress: string;
    running: boolean;
    lastError: string | null;
    wifiDirect: {
      enabled: boolean;
      connected: boolean;
      supported: boolean;
      unsupportedReason: string;
      message: string | null;
    };
  }) => void;
  toggleWifiDirect: (enabled: boolean) => Promise<{ ok: boolean; message?: string }>;
  setConnecting: (deviceId: string, value: boolean) => void;
  setConnected: (deviceId: string, value: boolean) => void;
  toggleFavorite: (deviceId: string) => Promise<void>;
  renameDevice: (deviceId: string, name: string) => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
  rescan: () => Promise<void>;
}

export const useDeviceStore = create<DeviceState>((set, get) => ({
  history: [],
  peers: new Map(),
  paired: new Set(),
  connecting: new Set(),
  connected: new Set(),

  networkAvailable: true,
  localAddress: '',
  discovering: false,
  discoveryError: null,
  loading: true,
  wifiDirect: {
    enabled: false,
    connected: false,
    supported: false,
    unsupportedReason: '',
    message: null,
  },

  refreshHistory: async () => {
    const [history, paired] = await Promise.all([
      deviceRepository.all(),
      pairedDeviceIds(),
    ]);
    set({ history, paired, loading: false });
  },

  applyDiscovery: (state) =>
    set({
      peers: state.peers,
      networkAvailable: state.networkAvailable,
      localAddress: state.localAddress,
      discovering: state.running,
      discoveryError: state.lastError,
      wifiDirect: {
        enabled: state.wifiDirect.enabled,
        connected: state.wifiDirect.connected,
        supported: state.wifiDirect.supported,
        unsupportedReason: state.wifiDirect.unsupportedReason,
        message: state.wifiDirect.message,
      },
    }),

  toggleWifiDirect: async (enabled) => {
    if (!enabled) {
      await DiscoveryService.disableWifiDirect();
      return { ok: true };
    }
    return DiscoveryService.enableWifiDirect();
  },

  setConnecting: (deviceId, value) =>
    set((current) => {
      const next = new Set(current.connecting);
      if (value) next.add(deviceId);
      else next.delete(deviceId);
      return { connecting: next };
    }),

  setConnected: (deviceId, value) =>
    set((current) => {
      const next = new Set(current.connected);
      if (value) next.add(deviceId);
      else next.delete(deviceId);
      return { connected: next };
    }),

  toggleFavorite: async (deviceId) => {
    const device = get().history.find((item) => item.deviceId === deviceId);
    if (!device) return;
    await deviceRepository.setFavorite(deviceId, !device.isFavorite);
    await get().refreshHistory();
  },

  renameDevice: async (deviceId, name) => {
    await deviceRepository.rename(deviceId, name);
    await get().refreshHistory();
  },

  removeDevice: async (deviceId) => {
    await SessionManager.disconnect(deviceId).catch(() => undefined);
    // Cascades to the pairing, so the device must consent again next time.
    await deviceRepository.remove(deviceId);
    await get().refreshHistory();
  },

  rescan: async () => {
    await DiscoveryService.refresh();
  },
}));

// ---------------------------------------------------------------- selectors

/**
 * Merge persisted history with live discovery (§10).
 *
 * This is the join that makes the whole product work: both sides are keyed by
 * `deviceId`, so
 *
 *   - a remembered device that is on the network shows as Online, "Previously
 *     connected", and can be sent to immediately with no pairing (§45);
 *   - a remembered device that is not shows as Offline but keeps its row, its
 *     stats and its last-seen time (§9, §12);
 *   - a device whose IP changed matches the same row and updates its address,
 *     rather than appearing twice (§39).
 *
 * Memoised on its four inputs, because it builds a fresh array of fresh
 * objects and is read through `useSyncExternalStore` — see store/memo.ts.
 */
const buildDeviceList = memoizeSelector(
  (
    history: DeviceRecord[],
    peers: Map<string, DiscoveredPeer>,
    paired: Set<string>,
    connecting: Set<string>,
    connected: Set<string>,
  ): DeviceListItem[] => {
    const items: DeviceListItem[] = history.map((record) => {
      const peer = peers.get(record.deviceId);
      return {
        ...record,
        // Prefer the name the peer is currently advertising: it may have been
        // renamed since we last connected.
        name: peer?.deviceName ?? record.name,
        lastKnownAddress: peer?.host ?? record.lastKnownAddress,
        lastKnownPort: peer?.port ?? record.lastKnownPort,
        lastSeenAt: peer ? Date.now() : record.lastSeenAt,
        status: statusFor(
          connecting,
          connected,
          record.deviceId,
          Boolean(peer),
        ),
        previouslyConnected: true,
        isPaired: paired.has(record.deviceId),
        hasSession: connected.has(record.deviceId),
        ...(peer ? { peer } : {}),
      };
    });

    // Peers we have never connected to: shown so they can be paired, but not
    // written to history until a connection actually succeeds.
    const known = new Set(history.map((record) => record.deviceId));
    for (const [deviceId, peer] of peers) {
      if (known.has(deviceId)) continue;
      items.push({
        deviceId,
        name: peer.deviceName,
        platform: peer.platform,
        deviceType: peer.deviceType,
        avatar: '',
        firstConnectedAt: 0,
        lastConnectedAt: 0,
        lastSeenAt: peer.discoveredAt,
        lastKnownAddress: peer.host,
        lastKnownPort: peer.port,
        isFavorite: false,
        filesSent: 0,
        filesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        status: statusFor(connecting, connected, deviceId, true),
        previouslyConnected: false,
        isPaired: false,
        hasSession: connected.has(deviceId),
        peer,
      });
    }

    return items.sort(compareDevices);
  },
);

export function deviceListItems(state: DeviceState): DeviceListItem[] {
  return buildDeviceList(
    state.history,
    state.peers,
    state.paired,
    state.connecting,
    state.connected,
  );
}

function statusFor(
  connecting: Set<string>,
  connected: Set<string>,
  deviceId: string,
  discovered: boolean,
): DeviceStatus {
  if (connecting.has(deviceId)) return 'connecting';
  // A live session outranks discovery: we are demonstrably able to reach this
  // device, whether or not it is currently announcing itself over mDNS.
  if (connected.has(deviceId)) return 'online';
  return discovered ? 'online' : 'offline';
}

/**
 * Favourites first, then online, then most recently connected.
 *
 * Favourites outrank online status deliberately (§13: favourites appear at the
 * top of Home, Send and Devices) — a starred device the user is waiting for
 * should not sink below a stranger who happens to be awake.
 */
function compareDevices(a: DeviceListItem, b: DeviceListItem): number {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

  const aOnline = a.status !== 'offline';
  const bOnline = b.status !== 'offline';
  if (aOnline !== bOnline) return aOnline ? -1 : 1;

  const aSeen = Math.max(a.lastConnectedAt, a.lastSeenAt);
  const bSeen = Math.max(b.lastConnectedAt, b.lastSeenAt);
  if (aSeen !== bSeen) return bSeen - aSeen;

  return a.name.localeCompare(b.name);
}

const filterFavorites = memoizeSelector((items: DeviceListItem[]) =>
  items.filter((item) => item.isFavorite),
);

export function favoriteDevices(state: DeviceState): DeviceListItem[] {
  return filterFavorites(deviceListItems(state));
}

const filterOnline = memoizeSelector((items: DeviceListItem[]) =>
  items.filter((item) => item.status !== 'offline'),
);

export function onlineDevices(state: DeviceState): DeviceListItem[] {
  return filterOnline(deviceListItems(state));
}

/**
 * One device by id.
 *
 * Needs no memoisation of its own: it returns an element of the memoised list,
 * so the reference is stable for as long as the list is.
 */
export function findDevice(
  state: DeviceState,
  deviceId: string,
): DeviceListItem | null {
  return deviceListItems(state).find((item) => item.deviceId === deviceId) ?? null;
}
