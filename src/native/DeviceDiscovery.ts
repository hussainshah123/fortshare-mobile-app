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
