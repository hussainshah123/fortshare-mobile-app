import type { EventSubscription } from 'react-native';
import Net from './specs/NativeFortShareNet';
import { typedEvent } from './events';
import type {
  DiscoveryErrorEvent,
  NetworkChangedEvent,
  PeerLostEvent,
} from './events';
import type { DiscoveredPeer } from '../models/device';
import { PROTOCOL_VERSION } from '../constants/protocol';

export type AddressKind =
  | 'wifi'
  | 'hotspot'
  | 'ethernet'
  | 'cellular'
  | 'vpn'
  | 'p2p'
  | 'other';

export interface LocalAddress {
  interfaceName: string;
  address: string;
  kind: AddressKind;
}

export interface NetworkInfo {
  /** Best guess, or "" when there is no usable network. */
  primary: string;
  addresses: LocalAddress[];
}

export interface WifiDirectSupport {
  supported: boolean;
  /** `permission-required` means the hardware can, but consent is missing. */
  reason: string;
  permission: string;
  hasPermission: boolean;
}

export interface WifiDirectState {
  enabled: boolean;
  connected: boolean;
  isGroupOwner: boolean;
  groupOwnerAddress: string;
  message: string | null;
}

export interface WifiDirectLink {
  /** The group owner's P2P address — where the TCP listener is reachable. */
  host: string;
  port: number;
  isGroupOwner: boolean;
}

/**
 * A nearby Wi-Fi Direct device.
 *
 * Not necessarily a FortShare peer: Wi-Fi Direct is on whenever Wi-Fi is, so
 * phones appear here without running the app. A group can still be formed with
 * any of them, and mDNS identifies the app afterwards over the P2P network.
 */
export interface RawWifiDirectPeer {
  name: string;
  /** P2P hardware address — what `connectWifiDirect` takes. */
  address: string;
  status: 'available' | 'invited' | 'connected' | 'failed' | 'unavailable';
}

/** A peer seen over Wi-Fi Direct. */
export interface WifiDirectPeer extends DiscoveredPeer {
  /** Hardware address, needed to form a group with this peer. */
  p2pAddress: string;
}

export interface AdvertiseConfig {
  deviceId: string;
  deviceName: string;
  platform: string;
  deviceType: string;
  fingerprint: string;
  /** The port our own TCP listener bound to. Published in the TXT record. */
  port: number;
}

/**
 * mDNS/DNS-SD advertise + browse, as required by §6/§35.
 *
 * Discovery alone is enough to recognise a known device: the TXT record
 * carries `deviceId`, so a peer is matched against history before any
 * connection is attempted.
 */
export const DeviceDiscovery = {
  async start(config: AdvertiseConfig): Promise<void> {
    await Net.startDiscovery(
      JSON.stringify({ ...config, protocolVersion: PROTOCOL_VERSION }),
    );
  },

  async stop(): Promise<void> {
    await Net.stopDiscovery();
  },

  /** Re-publish and re-browse. Call after the network changes. */
  async refresh(): Promise<void> {
    await Net.refreshDiscovery();
  },

  /** Local IPv4 on the active interface, or "" when there is no network. */
  getLocalAddress(): Promise<string> {
    return Net.getLocalAddress();
  },

  /**
   * Every address this device could be reached on, best first.
   *
   * A phone routinely holds several site-local IPv4 addresses at once — Wi-Fi,
   * mobile data, a hotspot bridge, a VPN — and only some are reachable from a
   * given peer. Publishing a single guess is what produces "no route to host".
   */
  async getNetworkInfo(): Promise<NetworkInfo> {
    return JSON.parse(await Net.getNetworkInfo()) as NetworkInfo;
  },

  // ------------------------------------------------------------ wi-fi direct

  /**
   * Whether Wi-Fi Direct is usable here.
   *
   * Distinguishes unsupported hardware from a missing permission, because the
   * two need different responses: one is a dead end, the other is a prompt.
   */
  async wifiDirectSupport(): Promise<WifiDirectSupport> {
    return JSON.parse(await Net.wifiDirectSupported()) as WifiDirectSupport;
  },

  /**
   * Advertise and browse over Wi-Fi Direct — no router in the path.
   *
   * This is the path that works when the router blocks client-to-client
   * traffic, or when the two devices are on different networks entirely.
   */
  async startWifiDirect(config: AdvertiseConfig): Promise<void> {
    await Net.startWifiDirect(
      JSON.stringify({ ...config, protocolVersion: PROTOCOL_VERSION }),
    );
  },

  stopWifiDirect(): Promise<void> {
    return Net.stopWifiDirect();
  },

  /** Form a group and resolve once the peer is reachable over it. */
  async connectWifiDirect(
    p2pAddress: string,
    timeoutMs = 30_000,
  ): Promise<WifiDirectLink> {
    return JSON.parse(
      await Net.connectWifiDirect(p2pAddress, timeoutMs),
    ) as WifiDirectLink;
  },

  disconnectWifiDirect(): Promise<void> {
    return Net.disconnectWifiDirect();
  },

  onWifiDirectPeerFound(
    handler: (peer: WifiDirectPeer) => void,
  ): EventSubscription {
    return typedEvent<WifiDirectPeer>(
      Net.onWifiDirectPeerFound,
      'onWifiDirectPeerFound',
    )(handler);
  },

  onWifiDirectPeerLost(
    handler: (event: PeerLostEvent) => void,
  ): EventSubscription {
    return typedEvent<PeerLostEvent>(
      Net.onWifiDirectPeerLost,
      'onWifiDirectPeerLost',
    )(handler);
  },

  onWifiDirectRawPeers(
    handler: (event: { peers: RawWifiDirectPeer[] }) => void,
  ): EventSubscription {
    return typedEvent<{ peers: RawWifiDirectPeer[] }>(
      Net.onWifiDirectRawPeers,
      'onWifiDirectRawPeers',
    )(handler);
  },

  onWifiDirectStateChanged(
    handler: (state: WifiDirectState) => void,
  ): EventSubscription {
    return typedEvent<WifiDirectState>(
      Net.onWifiDirectStateChanged,
      'onWifiDirectStateChanged',
    )(handler);
  },

  onDeviceFound(handler: (peer: DiscoveredPeer) => void): EventSubscription {
    return typedEvent<DiscoveredPeer>(Net.onPeerFound, 'onPeerFound')(handler);
  },

  onDeviceLost(handler: (event: PeerLostEvent) => void): EventSubscription {
    return typedEvent<PeerLostEvent>(Net.onPeerLost, 'onPeerLost')(handler);
  },

  onError(handler: (event: DiscoveryErrorEvent) => void): EventSubscription {
    return typedEvent<DiscoveryErrorEvent>(
      Net.onDiscoveryError,
      'onDiscoveryError',
    )(handler);
  },

  onNetworkChanged(
    handler: (event: NetworkChangedEvent) => void,
  ): EventSubscription {
    return typedEvent<NetworkChangedEvent>(
      Net.onNetworkChanged,
      'onNetworkChanged',
    )(handler);
  },
};
