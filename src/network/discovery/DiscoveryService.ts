import type { EventSubscription } from 'react-native';
import { DeviceDiscovery } from '../../native';
import type { DirectGroup } from '../../native/DeviceDiscovery';
import { deviceRepository } from '../../database/repositories';
import type { DiscoveredPeer, LocalIdentity } from '../../models/device';
import type {
  RawWifiDirectPeer,
  WifiDirectPeer,
  WifiDirectState,
  WifiDirectSupport,
} from '../../native/DeviceDiscovery';
import { requestWifiDirectAccess } from '../../services/permissions';
import { PROTOCOL_VERSION } from '../../constants/protocol';
import { logger } from '../../services/log';

const log = logger('discovery');

/**
 * Turn a machine reason into something worth showing a user.
 *
 * The short codes travel from native so the UI can branch on them; every one
 * that reaches a person has to become a sentence that says what to do.
 */
export function describeWifiDirectReason(reason: string): string {
  switch (reason) {
    case 'wifi-off':
      return 'Turn Wi-Fi on. It does not need to be connected to a network, and no internet is required.';
    case 'location-off':
      return 'Turn Location on in Settings. Android will not scan for nearby devices while it is off — it is not used for your position, only to find the other phone.';
    case 'permission-required':
      return 'FortShare needs the nearby-devices permission to find phones around you.';
    default:
      return reason;
  }
}

export interface DiscoveryState {
  /** Live peers keyed by deviceId — the identity from the TXT record. */
  peers: Map<string, DiscoveredPeer>;
  networkAvailable: boolean;
  localAddress: string;
  running: boolean;
  lastError: string | null;
  /** Wi-Fi Direct: off until the user turns it on. */
  wifiDirect: WifiDirectState & { supported: boolean; unsupportedReason: string };
  /** Nearby Wi-Fi Direct devices, whether or not they run FortShare. */
  wifiDirectCandidates: RawWifiDirectPeer[];
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
  /**
   * Whether this device has a usable local network.
   *
   * Starts `false` and is established from the actual addresses at startup.
   * It used to default to `true` and rely on a ConnectivityManager callback to
   * correct it — but that callback only fires when a matching network
   * *appears*, so a device that started with Wi-Fi already off was never
   * corrected. The app then advertised on "(no address)", showed itself as
   * "Ready to Share", and let every connection burn a 10-second timeout
   * before failing with ENETUNREACH.
   */
  private networkAvailable = false;
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
  /**
   * Whether the automatic Wi-Fi Direct fallback has already been tried for
   * the current "no network" episode.
   *
   * Without this a denied permission prompt would be re-shown on every
   * network event, which is how an app gets its permission permanently
   * blocked by the OS.
   */
  private autoDirectAttempted = false;
  private wifiDirectCandidates: RawWifiDirectPeer[] = [];
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
    // Ground truth: an address is the only proof of a usable network.
    this.networkAvailable = this.localAddress.length > 0;
    this.running = true;
    this.lastError = null;

    if (this.networkAvailable) {
      log.info(
        `advertising "${identity.deviceName}" as ${identity.platform} on port ${port}`,
        { address: this.localAddress },
      );
    } else {
      log.warn(
        'no local network address — falling back to wi-fi direct',
      );
      // Nothing discovered on a previous network is valid now.
      this.peers.clear();
    }
    this.emit();
    void this.maybeAutoEnableWifiDirect().catch(() => undefined);
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
    this.networkAvailable = this.localAddress.length > 0;
    if (!this.networkAvailable) this.peers.clear();
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
      wifiDirectCandidates: [...this.wifiDirectCandidates],
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
      return { ok: false, message: describeWifiDirectReason(support.reason) };
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
        DeviceDiscovery.onWifiDirectRawPeers((event) => {
          this.wifiDirectCandidates = event.peers;
          log.debug(`wi-fi direct sees ${event.peers.length} nearby device(s)`, {
            names: event.peers.map((peer) => peer.name),
          });
          this.emit();
        }),
        DeviceDiscovery.onWifiDirectStateChanged((state) => {
          const wasConnected = this.wifiDirect.connected;
          this.wifiDirect = { ...this.wifiDirect, ...state };
          if (state.message) log.warn(`wi-fi direct: ${state.message}`);

          /**
           * A group just formed: re-scan.
           *
           * The group brings up a new network interface (192.168.49.x) that
           * both devices share, and mDNS advertises on all interfaces — so a
           * refresh here is what identifies the peer as a FortShare device.
           * Without it the group exists but nothing knows who is on it.
           */
          if (!wasConnected && state.connected) {
            log.info('wi-fi direct group formed — rescanning over the new link');
            void this.refresh().catch(() => undefined);
          }
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

  /**
   * Fall back to Wi-Fi Direct when there is no network at all.
   *
   * Wi-Fi switched on but joined to nothing is not an error state — it is the
   * one case where Wi-Fi Direct is not merely a workaround but the *only*
   * route. There is no address, so mDNS has nothing to advertise on and no
   * peer can be discovered; the radio, however, is perfectly capable of
   * forming a P2P group.
   *
   * This was previously opt-in behind a toggle for two reasons: it needs a
   * permission the local-network path does not, and forming a group can
   * disturb the device's Wi-Fi connection. The second reason does not apply
   * here — there is no connection to disturb — and the first is a prompt the
   * user will understand, because they are staring at an app that has just
   * told them it cannot find anything.
   *
   * Tried once per episode, and never disabled automatically: a group that
   * forms brings up its own interface and would otherwise look like "the
   * network came back", turning itself straight off again.
   */
  private async maybeAutoEnableWifiDirect(): Promise<void> {
    if (this.networkAvailable || this.wifiDirect.enabled) return;
    if (this.autoDirectAttempted || !this.running) return;
    this.autoDirectAttempted = true;

    const support = await this.wifiDirectSupport();
    // 'permission-required' is the one refusal worth prompting through; the
    // rest (no hardware, Wi-Fi radio off) cannot be fixed from here.
    if (!support.supported && support.reason !== 'permission-required') {
      log.info(
        `no network and no wi-fi direct fallback available: ${support.reason}`,
      );
      return;
    }

    log.info('no network — turning on wi-fi direct to find devices directly');
    const result = await this.enableWifiDirect();
    if (!result.ok) {
      log.warn(`wi-fi direct fallback unavailable: ${result.message ?? ''}`);
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
    const peer = this.peers.get(deviceId);
    if (!peer) return null;

    /**
     * Find this device among the raw Wi-Fi Direct candidates.
     *
     * A P2P service record gives us a deviceId, but it often never arrives —
     * whereas the raw peer list almost always does. Raw peers carry only a
     * name and a hardware address, so the deviceId has to be bridged some
     * other way.
     *
     * Matching on name is a heuristic, but a strong one here: Android's P2P
     * device name defaults to the same model string the app advertises
     * ("HUAWEI JSN-L22"), so the two line up. It is only ever used to *offer*
     * a direct connection — identity is still proved by the handshake's
     * Ed25519 signature once the group is up, so a wrong guess costs a failed
     * invitation, never a misplaced trust decision.
     */
    const p2pAddress =
      this.p2pAddresses.get(deviceId) ?? this.matchCandidateByName(peer.deviceName);

    if (!p2pAddress) {
      log.warn(
        `no wi-fi direct candidate matches ${peer.deviceName}`,
        { candidates: this.wifiDirectCandidates.map((entry) => entry.name) },
      );
      return null;
    }

    log.info(`forming wi-fi direct group with ${peer.deviceName}`, {
      p2pAddress,
      matchedByName: !this.p2pAddresses.has(deviceId),
    });

    /**
     * Forming a group needs the *other* user to accept Android's own
     * invitation dialog, so this blocks for as long as that takes. Surfacing
     * it through state means the UI can say what is being waited for instead
     * of appearing frozen for thirty seconds.
     */
    this.wifiDirect = {
      ...this.wifiDirect,
      message: `Waiting for ${peer.deviceName} to accept the connection…`,
    };
    this.emit();

    let link;
    try {
      link = await DeviceDiscovery.connectWifiDirect(p2pAddress);
    } finally {
      this.wifiDirect = { ...this.wifiDirect, message: null };
      this.emit();
    }

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

  /**
   * Host a direct group so another device can join with no router.
   *
   * The counterpart to `openWifiDirectRoute`, and a better one wherever it
   * can be used: forming a group with `connect()` makes the *other* device
   * show Android's invitation dialog and wait for a human to accept it, while
   * a hosted group is simply a Wi-Fi network — the joining device needs
   * nothing at all from this one.
   *
   * Returns null where hosting is not possible (iOS, no hardware, no
   * permission), so callers can fall back to an address-only code.
   */
  async hostDirectGroup(): Promise<DirectGroup | null> {
    const support = await this.wifiDirectSupport();
    /**
     * Hosting is not a scan, so location being off does not block it.
     *
     * That asymmetry is the useful part: on a device where peer discovery
     * will not start, showing a QR code still works — which makes this the
     * reliable path rather than the fallback.
     */
    if (
      !support.supported &&
      support.reason !== 'permission-required' &&
      support.reason !== 'location-off'
    ) {
      log.info(`cannot host a direct group: ${support.reason}`);
      return null;
    }
    if (!support.hasPermission) {
      const granted = await requestWifiDirectAccess();
      if (!granted) return null;
    }

    try {
      const group = await DeviceDiscovery.createDirectGroup();
      log.info(`hosting direct group "${group.ssid}" at ${group.host}`);
      this.wifiDirect = {
        ...this.wifiDirect,
        enabled: true,
        supported: true,
        connected: true,
        isGroupOwner: true,
        groupOwnerAddress: group.host,
      };
      this.emit();
      return group;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'could not host a direct group';
      log.warn(`hosting a direct group failed: ${message}`);
      return null;
    }
  }

  /** Tear down a group hosted by `hostDirectGroup`. */
  async stopDirectGroup(): Promise<void> {
    await DeviceDiscovery.removeDirectGroup().catch(() => undefined);
    this.wifiDirect = {
      ...this.wifiDirect,
      connected: false,
      isGroupOwner: false,
      groupOwnerAddress: '',
    };
    this.emit();
  }

  /**
   * Join a group another device is hosting, and route this app over it.
   *
   * Resolves with the address to dial on that network. Throws with a message
   * fit to show the user, because every failure here is something they can
   * act on — move closer, keep the other screen open, turn Wi-Fi on.
   */
  async joinDirectGroup(ssid: string, passphrase: string): Promise<string> {
    log.info(`joining direct group "${ssid}"`);
    const { host } = await DeviceDiscovery.joinDirectGroup(ssid, passphrase);
    this.wifiDirect = {
      ...this.wifiDirect,
      connected: true,
      isGroupOwner: false,
      groupOwnerAddress: host,
    };
    this.emit();
    log.info(`joined "${ssid}" — group owner is ${host}`);
    return host;
  }

  /** Leave a group joined by `joinDirectGroup`. */
  async leaveDirectGroup(): Promise<void> {
    await DeviceDiscovery.leaveDirectGroup().catch(() => undefined);
    this.wifiDirect = { ...this.wifiDirect, connected: false, groupOwnerAddress: '' };
    this.emit();
  }

  /**
   * Whether this device could be reached over Wi-Fi Direct.
   *
   * True once P2P service discovery has seen it, which happens even when the
   * two devices share no network at all — the case where mDNS finds nothing.
   */
  canReachViaWifiDirect(deviceId: string): boolean {
    return this.p2pAddresses.has(deviceId);
  }

  /** Whether Wi-Fi Direct is currently switched on. */
  isWifiDirectEnabled(): boolean {
    return this.wifiDirect.enabled;
  }

  /**
   * Invite a nearby Wi-Fi Direct device to form a group.
   *
   * Takes a P2P address rather than a deviceId, because at this point we do
   * not know who the device is — that is the whole point. Once the group is
   * up, mDNS over the new interface identifies it.
   */
  async inviteWifiDirect(address: string): Promise<void> {
    log.info(`inviting ${address} to form a wi-fi direct group`);
    await DeviceDiscovery.connectWifiDirect(address);
    // The state listener above rescans once the group is reported formed;
    // this covers the case where the group was already up.
    await this.refresh().catch(() => undefined);
  }

  /** Whether the hardware could do Wi-Fi Direct if the user turned it on. */
  isWifiDirectAvailable(): boolean {
    return (
      this.wifiDirect.supported ||
      this.wifiDirect.unsupportedReason === 'permission-required'
    );
  }

  /**
   * Loosely match a FortShare device name to a raw P2P device name.
   *
   * Normalised because the two sources punctuate differently — one may report
   * "HUAWEI JSN-L22" and the other "Huawei JSN L22".
   */
  private matchCandidateByName(deviceName: string): string | null {
    const normalise = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalise(deviceName);
    if (target.length < 3) return null;

    const exact = this.wifiDirectCandidates.find(
      (candidate) => normalise(candidate.name) === target,
    );
    if (exact) return exact.address;

    // One name containing the other covers "HUAWEI JSN-L22" vs "JSN-L22".
    const partial = this.wifiDirectCandidates.find((candidate) => {
      const name = normalise(candidate.name);
      return name.length >= 3 && (name.includes(target) || target.includes(name));
    });
    return partial?.address ?? null;
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
      // The radio is still there even when no network is: this is precisely
      // when Wi-Fi Direct is the only way to reach anyone.
      await this.maybeAutoEnableWifiDirect().catch(() => undefined);
      return;
    }

    // A real network is back; a later loss should be allowed to try again.
    this.autoDirectAttempted = false;

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
