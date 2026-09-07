import type { EventSubscription } from 'react-native';
import { DeviceDiscovery } from '../../native';
import { deviceRepository } from '../../database/repositories';
import type { DiscoveredPeer, LocalIdentity } from '../../models/device';
import { PROTOCOL_VERSION } from '../../constants/protocol';

export interface DiscoveryState {
  /** Live peers keyed by deviceId — the identity from the TXT record. */
  peers: Map<string, DiscoveredPeer>;
  networkAvailable: boolean;
  localAddress: string;
  running: boolean;
  lastError: string | null;
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
  private listeners = new Set<StateListener>();
  private identity: LocalIdentity | null = null;
  private port = 0;

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
    this.emit();
  }

  async stop(): Promise<void> {
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
    };
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
    if (peer.protocolVersion !== PROTOCOL_VERSION) return;

    this.peers.set(peer.deviceId, { ...peer, discoveredAt: Date.now() });

    // Refresh liveness/address on the history row if we have one. This is the
    // §39 path: same deviceId, new address, one row.
    void deviceRepository.touchFromDiscovery(peer).catch(() => undefined);

    this.emit();
  }

  private onLost(deviceId: string): void {
    if (!this.peers.delete(deviceId)) return;
    // Deliberately no DB write: a device going offline must not alter its
    // history row or statistics (§9).
    this.emit();
  }

  private onError(message: string): void {
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
