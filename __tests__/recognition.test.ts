import {
  deviceListItems,
  favoriteDevices,
  findDevice,
  onlineDevices,
} from '../src/store/deviceStore';
import type { DeviceRecord, DiscoveredPeer } from '../src/models/device';

/**
 * The recognition join (§10, §39, §45).
 *
 * `deviceListItems` is where persisted history meets live discovery. It is the
 * single most product-critical function in the app: it decides whether a
 * remembered device reads as "Online · Previously connected" (send now, no
 * pairing) or as a stranger.
 */

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: 'android-2222',
    name: 'Samsung S25',
    platform: 'android',
    deviceType: 'phone',
    avatar: '📱',
    firstConnectedAt: 1_600_000_000_000,
    lastConnectedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    lastKnownAddress: '192.168.1.20',
    lastKnownPort: 54312,
    isFavorite: false,
    filesSent: 18,
    filesReceived: 7,
    bytesSent: 4_200_000_000,
    bytesReceived: 1_800_000_000,
    ...overrides,
  };
}

function peer(overrides: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    deviceId: 'android-2222',
    deviceName: 'Samsung S25',
    platform: 'android',
    deviceType: 'phone',
    fingerprint: 'abcd1234abcd1234',
    protocolVersion: 1,
    host: '192.168.1.20',
    port: 54312,
    discoveredAt: Date.now(),
    ...overrides,
  };
}

/** Minimal state slice; only the fields the selector reads. */
function state(options: {
  history?: DeviceRecord[];
  peers?: DiscoveredPeer[];
  paired?: string[];
  connecting?: string[];
}) {
  return {
    history: options.history ?? [],
    peers: new Map((options.peers ?? []).map((item) => [item.deviceId, item])),
    paired: new Set(options.paired ?? []),
    connecting: new Set(options.connecting ?? []),
    networkAvailable: true,
    localAddress: '192.168.1.10',
    discovering: true,
    discoveryError: null,
    loading: false,
    refreshHistory: async () => {},
    applyDiscovery: () => {},
    setConnecting: () => {},
    toggleFavorite: async () => {},
    renameDevice: async () => {},
    removeDevice: async () => {},
    rescan: async () => {},
  };
}

describe('a remembered device that is on the network (§45)', () => {
  it('is online and flagged as previously connected', () => {
    const [item] = deviceListItems(
      state({ history: [record()], peers: [peer()], paired: ['android-2222'] }),
    );

    expect(item!.status).toBe('online');
    expect(item!.previouslyConnected).toBe(true);
    expect(item!.isPaired).toBe(true);
    // The live peer is attached, which is what lets "Send Files" dial without
    // a rescan.
    expect(item!.peer?.port).toBe(54312);
  });

  it('keeps its statistics', () => {
    const [item] = deviceListItems(
      state({ history: [record()], peers: [peer()] }),
    );
    expect(item!.filesSent).toBe(18);
    expect(item!.bytesSent).toBe(4_200_000_000);
    expect(item!.firstConnectedAt).toBe(1_600_000_000_000);
  });
});

describe('a remembered device that is offline (§9, §12)', () => {
  it('stays in the list with its stats and last-seen time', () => {
    const items = deviceListItems(state({ history: [record()], peers: [] }));

    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('offline');
    // Going offline must never prune the row or reset the counters.
    expect(items[0]!.previouslyConnected).toBe(true);
    expect(items[0]!.filesSent).toBe(18);
    expect(items[0]!.lastSeenAt).toBe(1_700_000_000_000);
  });
});

describe('a device whose IP changed (§39)', () => {
  it('matches the same row and updates the address, with no duplicate', () => {
    const items = deviceListItems(
      state({
        history: [record({ lastKnownAddress: '192.168.1.20' })],
        // Same deviceId, new DHCP lease.
        peers: [peer({ host: '192.168.1.45' })],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('online');
    expect(items[0]!.lastKnownAddress).toBe('192.168.1.45');
  });

  it('does not match on address when the deviceId differs', () => {
    const items = deviceListItems(
      state({
        history: [record({ deviceId: 'android-2222' })],
        // A different device that happens to have inherited the old IP.
        peers: [peer({ deviceId: 'android-9999', deviceName: 'Someone else' })],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items.find((i) => i.deviceId === 'android-2222')!.status).toBe('offline');
    expect(items.find((i) => i.deviceId === 'android-9999')!.previouslyConnected)
      .toBe(false);
  });
});

describe('a device that has been renamed', () => {
  it('prefers the name it is currently advertising', () => {
    const [item] = deviceListItems(
      state({
        history: [record({ name: 'Old name' })],
        peers: [peer({ deviceName: 'Samsung S25 Ultra' })],
      }),
    );
    expect(item!.name).toBe('Samsung S25 Ultra');
  });

  it('falls back to the stored name when offline', () => {
    const [item] = deviceListItems(state({ history: [record({ name: 'Old name' })] }));
    expect(item!.name).toBe('Old name');
  });
});

describe('a never-before-seen device', () => {
  it('appears as a new device without entering history', () => {
    const [item] = deviceListItems(
      state({ peers: [peer({ deviceId: 'ios-new', deviceName: 'Unknown device' })] }),
    );

    expect(item!.previouslyConnected).toBe(false);
    expect(item!.isPaired).toBe(false);
    expect(item!.firstConnectedAt).toBe(0);
  });
});

describe('ordering', () => {
  it('puts favourites first, then online, then most recent (§13)', () => {
    const offlineFavorite = record({
      deviceId: 'fav-offline',
      name: 'MacBook Pro',
      isFavorite: true,
      lastConnectedAt: 1,
    });
    const onlineStranger = record({
      deviceId: 'online-plain',
      name: 'Pixel 8',
      lastConnectedAt: 2,
    });
    const oldOffline = record({
      deviceId: 'old-offline',
      name: 'Old iPad',
      lastConnectedAt: 3,
      lastSeenAt: 3,
    });

    const items = deviceListItems(
      state({
        history: [oldOffline, onlineStranger, offlineFavorite],
        peers: [peer({ deviceId: 'online-plain', deviceName: 'Pixel 8' })],
      }),
    );

    // A starred device the user is waiting for should not sink below a
    // stranger who happens to be awake.
    expect(items.map((item) => item.deviceId)).toEqual([
      'fav-offline',
      'online-plain',
      'old-offline',
    ]);
  });

  it('exposes favourites on their own', () => {
    const items = favoriteDevices(
      state({
        history: [
          record({ deviceId: 'a', isFavorite: true }),
          record({ deviceId: 'b', isFavorite: false }),
        ],
      }),
    );
    expect(items.map((item) => item.deviceId)).toEqual(['a']);
  });
});

describe('connecting state', () => {
  it('overrides online while the handshake is in flight', () => {
    const [item] = deviceListItems(
      state({
        history: [record()],
        peers: [peer()],
        connecting: ['android-2222'],
      }),
    );
    expect(item!.status).toBe('connecting');
  });
});

/**
 * Snapshot stability.
 *
 * Zustand v5 reads selectors through `useSyncExternalStore`, which compares
 * each result with `Object.is`. A selector that rebuilds its output every call
 * makes the store look permanently changed and React re-renders forever —
 * observed on device as "The result of getSnapshot should be cached to avoid
 * an infinite loop", which then took the whole Home screen down.
 *
 * These tests pin the contract that made that bug possible.
 */
describe('selector reference stability', () => {
  it('returns the identical array while the inputs are unchanged', () => {
    const slice = state({ history: [record()], peers: [peer()] });

    // Same object identity, not merely deep equality — that is what
    // Object.is compares.
    expect(deviceListItems(slice)).toBe(deviceListItems(slice));
    expect(favoriteDevices(slice)).toBe(favoriteDevices(slice));
    expect(onlineDevices(slice)).toBe(onlineDevices(slice));
  });

  it('returns the identical device object across calls', () => {
    const slice = state({ history: [record()], peers: [peer()] });
    expect(findDevice(slice, 'android-2222')).toBe(
      findDevice(slice, 'android-2222'),
    );
  });

  it('recomputes when history changes', () => {
    const first = state({ history: [record()], peers: [peer()] });
    const second = state({
      history: [record({ name: 'Renamed' })],
      peers: [peer()],
    });

    const before = deviceListItems(first);
    const after = deviceListItems(second);
    expect(after).not.toBe(before);
    expect(after[0]!.name).toBe('Samsung S25'); // peer name still wins
  });

  it('recomputes when the peer set changes', () => {
    const history = [record()];
    const online = state({ history, peers: [peer()] });
    const offline = state({ history, peers: [] });

    expect(deviceListItems(online)).not.toBe(deviceListItems(offline));
    expect(deviceListItems(offline)[0]!.status).toBe('offline');
  });

  it('recomputes when a device starts connecting', () => {
    const history = [record()];
    const peers = [peer()];
    const idle = state({ history, peers });
    const dialling = state({ history, peers, connecting: ['android-2222'] });

    expect(deviceListItems(idle)).not.toBe(deviceListItems(dialling));
  });
});
