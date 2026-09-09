import type { EventSubscription } from 'react-native';
import { DeviceDiscovery } from '../../native';
import { deviceRepository } from '../../database/repositories';
import type { DiscoveredPeer, LocalIdentity } from '../../models/device';
import type {
  WifiDirectPeer,
  WifiDirectState,
  WifiDirectSupport,
} from '../../native/DeviceDiscovery';
import { requestWifiDirectAccess } from '../../services/permissions';
import { PROTOCOL_VERSION } from '../../constants/protocol';
import { logger } from '../../services/log';

const log = logger('discovery');

export interface DiscoveryState {
  /** Live peers keyed by deviceId — the identity from the TXT record. */
  peers: Map<string, DiscoveredPeer>;
  networkAvailable: boolean;
  localAddress: string;
  running: boolean;
  lastError: string | null;
  /** Wi-Fi Direct: off until the user turns it on. */
  wifiDirect: WifiDirectState & { supported: boolean; unsupportedReason: string };
}

type StateListener = (state: DiscoveryState) => void;

/**
 * Advertise this device and track the peers around it (§6, §7, §8).
 *
 * The important property is that peers are keyed by `deviceId`, which arrives
 * in the mDNS TXT record. That means:
 *
 *   - a known device is recognised *before* any connection is made (§10);
 *   - a device whose IP changed keeps the same key, so it updates in place
 *     rather than appearing twice (§39);
 *   - the same code handles a router and a phone hotspot, because both are
 *     just a local network with multicast (§8).
 */
class DiscoveryServiceImpl {
  private peers = new Map<string, DiscoveredPeer>();
  private networkAvailable = true;
  private localAddress = '';
  private running = false;
  private lastError: string | null = null;

  private subscriptions: EventSubscription[] = [];
  private wifiDirectSubscriptions: EventSubscription[] = [];
  private listeners = new Set<StateListener>();
  private identity: LocalIdentity | null = null;
  private port = 0;

  /** P2P addresses for Wi-Fi Direct peers, keyed by deviceId. */
  private p2pAddresses = new Map<string, string>();
  private wifiDirect: DiscoveryState['wifiDirect'] = {
    enabled: false,
    connected: false,
    isGroupOwner: false,
    groupOwnerAddress: '',
    message: null,
    supported: false,
    unsupportedReason: '',
  };

  /**
   * @param port the port our own TCP listener bound to — published in the TXT
   *             record so peers know where to dial us.
   */
  async start(identity: LocalIdentity, port: number): Promise<void> {
    this.identity = identity;
    this.port = port;

    if (this.subscriptions.length === 0) {
      this.subscriptions.push(
        DeviceDiscovery.onDeviceFound((peer) => this.onFound(peer)),
        DeviceDiscovery.onDeviceLost((event) => this.onLost(event.deviceId)),
        DeviceDiscovery.onError((event) => this.onError(event.message)),
        DeviceDiscovery.onNetworkChanged((event) => {
          void this.onNetworkChanged(event.available, event.address);
        }),
      );
    }

    await DeviceDiscovery.start({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      platform: identity.platform,
      deviceType: identity.deviceType,
      fingerprint: identity.fingerprint,
      port,
    });

    this.localAddress = await DeviceDiscovery.getLocalAddress().catch(() => '');
    this.running = true;
    this.lastError = null;
    log.info(
      `advertising "${identity.deviceName}" as ${identity.platform} on port ${port}`,
      { address: this.localAddress || '(none)' },
    );
    this.emit();
  }

  async stop(): Promise<void> {
    await this.disableWifiDirect().catch(() => undefined);
    await DeviceDiscovery.stop().catch(() => undefined);
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    this.peers.clear();
    this.running = false;
    this.emit();
  }

  /** Re-publish under a new name without disturbing the deviceId. */
  async republish(identity: LocalIdentity): Promise<void> {
    this.identity = identity;
    if (!this.running) return;
    await DeviceDiscovery.stop().catch(() => undefined);
    await DeviceDiscovery.start({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      platform: identity.platform,
      deviceType: identity.deviceType,
      fingerprint: identity.fingerprint,
      port: this.port,
    });
  }

  /** User-initiated rescan. */
  async refresh(): Promise<void> {
    if (!this.running) {
      const identity = this.identity;
      if (identity && this.port) await this.start(identity, this.port);
      return;
    }
    // Peers that no longer answer will simply not be re-announced; clearing
    // first means a device that left while we were backgrounded disappears.
    this.peers.clear();
    this.emit();
    await DeviceDiscovery.refresh().catch((error: unknown) => {
      this.onError(error instanceof Error ? error.message : String(error));
    });
    this.localAddress = await DeviceDiscovery.getLocalAddress().catch(() => '');
    this.emit();
  }

  peer(deviceId: string): DiscoveredPeer | null {
    return this.peers.get(deviceId) ?? null;
  }

  isOnline(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  state(): DiscoveryState {
    return {
      peers: new Map(this.peers),
      networkAvailable: this.networkAvailable,
      localAddress: this.localAddress,
      running: this.running,
      lastError: this.lastError,
      wifiDirect: { ...this.wifiDirect },
    };
  }

  // ------------------------------------------------------------ wi-fi direct

  /** Whether this device can do Wi-Fi Direct, and whether consent exists. */
  async wifiDirectSupport(): Promise<WifiDirectSupport> {
    const support = await DeviceDiscovery.wifiDirectSupport().catch(() => ({
      supported: false,
      reason: 'Wi-Fi Direct could not be checked on this device.',
      permission: '',
      hasPermission: false,
    }));
    this.wifiDirect = {
      ...this.wifiDirect,
      supported: support.supported,
      unsupportedReason: support.supported ? '' : support.reason,
    };
    this.emit();
    return support;
  }

  /**
   * Turn Wi-Fi Direct on.
   *
   * Kept opt-in rather than always-on for two reasons: it needs a permission
   * the local-network path does not (location, below Android 13), and forming
   * a P2P group can disturb the device's normal Wi-Fi connection. Users who
   * never hit an isolating router should never have to think about it.
   */
  async enableWifiDirect(): Promise<{ ok: boolean; message?: string }> {
    const identity = this.identity;
    if (!identity || !this.port) {
      return { ok: false, message: 'FortShare is still starting up.' };
    }

    const support = await this.wifiDirectSupport();
    if (!support.supported && support.reason !== 'permission-required') {
      return { ok: false, message: support.reason };
    }

    if (!support.hasPermission) {
      const granted = await requestWifiDirectAccess();
      if (!granted) {
        return {
          ok: false,
          message:
            'Wi-Fi Direct needs the nearby-devices permission to find peers.',
        };
      }
    }

    if (this.wifiDirectSubscriptions.length === 0) {
      this.wifiDirectSubscriptions.push(
        DeviceDiscovery.onWifiDirectPeerFound((peer) => this.onDirectFound(peer)),
        DeviceDiscovery.onWifiDirectPeerLost((event) =>
          this.onDirectLost(event.deviceId),
        ),
        DeviceDiscovery.onWifiDirectStateChanged((state) => {
          this.wifiDirect = { ...this.wifiDirect, ...state };
          if (state.message) log.warn(`wi-fi direct: ${state.message}`);
          this.emit();
        }),
      );
    }

    try {
      await DeviceDiscovery.startWifiDirect({
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        platform: identity.platform,
        deviceType: identity.deviceType,
        fingerprint: identity.fingerprint,
        port: this.port,
      });
      this.wifiDirect = { ...this.wifiDirect, enabled: true, supported: true };
      log.info('wi-fi direct enabled — router is no longer in the path');
      this.emit();
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Wi-Fi Direct could not start';
      log.error(`wi-fi direct failed to start: ${message}`);
      this.wifiDirect = { ...this.wifiDirect, enabled: false, message };
      this.emit();
      return { ok: false, message };
    }
  }

  async disableWifiDirect(): Promise<void> {
    await DeviceDiscovery.stopWifiDirect().catch(() => undefined);
    for (const sub of this.wifiDirectSubscriptions) sub.remove();
    this.wifiDirectSubscriptions = [];

    // Drop the P2P-only peers; anything also visible over mDNS stays.
    for (const [deviceId] of this.p2pAddresses) {
      const peer = this.peers.get(deviceId);
      if (peer && !peer.host) this.peers.delete(deviceId);
    }
    this.p2pAddresses.clear();
    this.wifiDirect = {
      ...this.wifiDirect,
      enabled: false,
      connected: false,
      groupOwnerAddress: '',
    };
    this.emit();
  }

  /**
   * Form a Wi-Fi Direct group with a peer and return a dialable address.
   *
   * The group owner's address is where the listener is reachable, so this
   * hands back a peer the existing TCP path can use unchanged — same frames,
   * same handshake, same encryption.
   */
  async openWifiDirectRoute(deviceId: string): Promise<DiscoveredPeer | null> {
    const p2pAddress = this.p2pAddresses.get(deviceId);
    const peer = this.peers.get(deviceId);
    if (!p2pAddress || !peer) return null;

    log.info(`forming wi-fi direct group with ${peer.deviceName}`);
    const link = await DeviceDiscovery.connectWifiDirect(p2pAddress);

    if (link.isGroupOwner) {
      // We own the group, so the peer dials us. There is nothing for this
      // device to connect to.
      log.info('this device is the group owner — waiting for the peer to dial');
      return null;
    }

    const port = link.port || peer.port;
    if (!port) {
      throw new Error(
        `${peer.deviceName} joined but has not published a port yet — try again in a moment.`,
      );
    }

    const routed: DiscoveredPeer = { ...peer, host: link.host, port };
    this.peers.set(deviceId, routed);
    this.emit();
    log.info(`wi-fi direct route ready: ${link.host}:${port}`);
    return routed;
  }

  private onDirectFound(peer: WifiDirectPeer): void {
    if (peer.deviceId === this.identity?.deviceId) return;
    if (peer.protocolVersion !== PROTOCOL_VERSION) return;

    this.p2pAddresses.set(peer.deviceId, peer.p2pAddress);

    // Never downgrade a peer we can already reach over the LAN: an mDNS entry
    // has a working address, a P2P entry has none until a group is formed.
    const existing = this.peers.get(peer.deviceId);
    if (existing?.host) return;

    if (!existing) {
      log.info(`found ${peer.deviceName} over wi-fi direct`, {
        deviceId: peer.deviceId,
        p2pAddress: peer.p2pAddress,
      });
    }
    this.peers.set(peer.deviceId, { ...peer, discoveredAt: Date.now() });
    void deviceRepository.touchFromDiscovery(peer).catch(() => undefined);
    this.emit();
  }

  private onDirectLost(deviceId: string): void {
    this.p2pAddresses.delete(deviceId);
    const peer = this.peers.get(deviceId);
    // Only remove if this peer was P2P-only (no LAN address).
    if (peer && !peer.host) {
      this.peers.delete(deviceId);
      log.info(`lost ${peer.deviceName} (wi-fi direct)`);
      this.emit();
    }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ handlers

  private onFound(peer: DiscoveredPeer): void {
    // Ignore our own advertisement, which mDNS will happily echo back.
    if (peer.deviceId === this.identity?.deviceId) return;

    // A peer speaking a different protocol version cannot be transferred to,
    // so it is not shown as available (§6: only compatible devices).
    if (peer.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(
        `ignoring ${peer.deviceName}: speaks protocol v${peer.protocolVersion}, ` +
          `this build speaks v${PROTOCOL_VERSION}`,
      );
      return;
    }

    // Logged with the platform because cross-platform discovery is the leg
    // most likely to fail silently: Android resolves iOS through NSD, iOS
    // resolves Android through NWBrowser, and either can come up empty
    // without an error. Seeing "found … (ios)" on an Android device is the
    // proof that half works.
    if (!this.peers.has(peer.deviceId)) {
      log.info(`found ${peer.deviceName} (${peer.platform})`, {
        deviceId: peer.deviceId,
        address: peer.host || '(bonjour service)',
        port: peer.port,
        fingerprint: peer.fingerprint,
      });
    }

    this.peers.set(peer.deviceId, { ...peer, discoveredAt: Date.now() });

    // Refresh liveness/address on the history row if we have one. This is the
    // §39 path: same deviceId, new address, one row.
    void deviceRepository.touchFromDiscovery(peer).catch(() => undefined);

    this.emit();
  }

  private onLost(deviceId: string): void {
    const gone = this.peers.get(deviceId);
    if (!this.peers.delete(deviceId)) return;
    log.info(`lost ${gone?.deviceName ?? deviceId}`);
    // Deliberately no DB write: a device going offline must not alter its
    // history row or statistics (§9).
    this.emit();
  }

  private onError(message: string): void {
    log.error(`discovery error: ${message}`);
    this.lastError = message;
    this.emit();
  }

  /**
   * Wi-Fi came up, went down, or changed network.
   *
   * On any change every peer is dropped: addresses learned on the old network
   * are meaningless on the new one, and re-announcement is cheap.
   */
  private async onNetworkChanged(
    available: boolean,
    address: string,
  ): Promise<void> {
    const changed = available !== this.networkAvailable || address !== this.localAddress;
    this.networkAvailable = available;
    this.localAddress = address;

    if (!available) {
      log.warn('network went away — clearing peers');
      this.peers.clear();
      this.emit();
      return;
    }

    if (changed) {
      this.peers.clear();
      this.emit();
      const identity = this.identity;
      if (identity && this.running) {
        await this.republish(identity).catch(() => undefined);
      }
    }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const DiscoveryService = new DiscoveryServiceImpl();
