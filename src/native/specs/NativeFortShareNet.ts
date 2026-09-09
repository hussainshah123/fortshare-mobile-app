import { TurboModuleRegistry, type TurboModule } from 'react-native';
import type { EventEmitter, Int32 } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * The native data plane: mDNS discovery, TCP listener/sockets, frame codec and
 * file<->socket streaming.
 *
 * Every method takes and every event carries a **JSON string**. That is
 * deliberate: it keeps the codegen surface to primitives (no map/dictionary
 * marshalling to get subtly wrong on one platform), and the payloads here are
 * either tiny control messages or throttled counters — never file bytes.
 *
 * File bytes never cross this boundary. `sendFile`/`receiveFile` hand native a
 * path and an offset; native streams disk<->socket on a background thread and
 * reports progress at most a few times a second.
 */
export interface Spec extends TurboModule {
  // ---------------------------------------------------------------- discovery
  /**
   * Advertise this device as `_fortshare._tcp` and start browsing for peers.
   * @param configJson { deviceId, deviceName, platform, deviceType,
   *                     fingerprint, port, protocolVersion }
   */
  startDiscovery(configJson: string): Promise<void>;
  stopDiscovery(): Promise<void>;
  /** Re-publish and re-browse. Called after a network change. */
  refreshDiscovery(): Promise<void>;
  /** Local IPv4 of the active interface, or "" when offline. */
  getLocalAddress(): Promise<string>;

  /**
   * Every address this device could be reached on, as
   * { primary, addresses: [{ interfaceName, address, kind }] } JSON.
   *
   * `kind` is `wifi` | `hotspot` | `ethernet` | `cellular` | `vpn` | `other`.
   *
   * Needed because a phone routinely has several site-local IPv4 addresses at
   * once — Wi-Fi, mobile data, a hotspot bridge, a VPN — and only some are
   * reachable from a given peer. Publishing one guess produces
   * "EHOSTUNREACH"; publishing the candidates lets the other side try each.
   * Also the basis of the network diagnostics shown in Settings.
   */
  getNetworkInfo(): Promise<string>;

  // ------------------------------------------------------------ wi-fi direct
  /**
   * Whether this device can do Wi-Fi Direct at all.
   * Returns { supported, reason } JSON. Always unsupported on iOS.
   */
  wifiDirectSupported(): Promise<string>;

  /**
   * Advertise over Wi-Fi Direct and start looking for P2P peers.
   *
   * This is the path that does not involve the router at all: two devices
   * negotiate a group directly over Wi-Fi, so it works when they are on
   * different networks, on no network, or on a router whose client isolation
   * blocks them from reaching each other.
   *
   * @param configJson the same shape as startDiscovery.
   */
  startWifiDirect(configJson: string): Promise<void>;
  stopWifiDirect(): Promise<void>;

  /**
   * Form a Wi-Fi Direct group with a peer and resolve once it is usable.
   *
   * Resolves with { host, port, isGroupOwner } JSON — `host` is the group
   * owner's P2P address, which is what the TCP listener is reachable on.
   * Rejects if the group cannot be formed or the peer never publishes a port.
   */
  connectWifiDirect(deviceAddress: string, timeoutMs: Int32): Promise<string>;

  /** Leave the current group and stop advertising over P2P. */
  disconnectWifiDirect(): Promise<void>;

  // ----------------------------------------------------------------- sockets
  /** Bind the TCP listener on an ephemeral port. Resolves with that port. */
  startServer(): Promise<Int32>;
  stopServer(): Promise<void>;
  /**
   * Dial a peer. Resolves with a connectionId; rejects on timeout or refusal.
   * @param paramsJson { host, port, serviceRef, timeoutMs }
   *
   * `serviceRef` is the opaque Bonjour endpoint iOS's browser hands us.
   * Preferred there because letting the OS resolve the service also works over
   * peer-to-peer links that have no routable address. `host`/`port` is the
   * cross-platform path, used for Android peers and QR-scanned addresses.
   */
  connect(paramsJson: string): Promise<string>;
  disconnect(connectionId: string): Promise<void>;
  /** Send one CONTROL frame. `json` is a serialised ControlMessage. */
  sendControl(connectionId: string, json: string): Promise<void>;
  /**
   * Hand native the negotiated session key (base64url). Reserved for AEAD on
   * the data path; currently stored against the connection and unused.
   */
  setSessionKey(connectionId: string, keyB64: string): Promise<void>;

  // ---------------------------------------------------------------- transfer
  /**
   * Stream a file to the peer as DATA frames, starting at `offset`.
   * @param paramsJson { transferId, fileId, fileIndex, uri, offset, size, chunkSize }
   */
  sendFile(connectionId: string, paramsJson: string): Promise<void>;
  /**
   * Route inbound DATA frames for `fileIndex` straight to disk at `destPath`.
   * @param paramsJson { transferId, fileId, fileIndex, destPath, offset, size }
   */
  receiveFile(connectionId: string, paramsJson: string): Promise<void>;
  /** Stop streaming but keep partial state so it can be resumed. */
  pauseTransfer(connectionId: string, transferId: string): Promise<void>;
  /** Abandon the transfer and discard partial receive state. */
  cancelTransfer(connectionId: string, transferId: string): Promise<void>;

  // ------------------------------------------------------------------ events
  /** DiscoveredPeer JSON. */
  readonly onPeerFound: EventEmitter<string>;
  /** { deviceId } JSON. */
  readonly onPeerLost: EventEmitter<string>;
  /** { message } JSON. */
  readonly onDiscoveryError: EventEmitter<string>;
  /** { available, address } JSON — emitted on Wi-Fi up/down/change. */
  readonly onNetworkChanged: EventEmitter<string>;

  /**
   * A peer seen over Wi-Fi Direct, as DiscoveredPeer JSON plus
   * `p2pAddress` — the MAC-style address `connectWifiDirect` needs.
   */
  readonly onWifiDirectPeerFound: EventEmitter<string>;
  /** { deviceId } JSON. */
  readonly onWifiDirectPeerLost: EventEmitter<string>;
  /** { enabled, connected, isGroupOwner, groupOwnerAddress, message } JSON. */
  readonly onWifiDirectStateChanged: EventEmitter<string>;

  /** { connectionId, host, port, inbound } JSON. */
  readonly onConnection: EventEmitter<string>;
  /** { connectionId, message } JSON, where `message` is a ControlMessage. */
  readonly onControl: EventEmitter<string>;
  /** { connectionId, reason } JSON. */
  readonly onDisconnect: EventEmitter<string>;

  /** { transferId, fileId, fileIndex, transferredBytes, totalBytes } JSON. */
  readonly onSendProgress: EventEmitter<string>;
  /** { transferId, fileId, fileIndex, transferredBytes } JSON. */
  readonly onSendComplete: EventEmitter<string>;
  /** { transferId, fileId, fileIndex, transferredBytes, totalBytes } JSON. */
  readonly onReceiveProgress: EventEmitter<string>;
  /** { transferId, fileId, fileIndex, transferredBytes, path } JSON. */
  readonly onReceiveComplete: EventEmitter<string>;
  /** { transferId, fileId, message, recoverable } JSON. */
  readonly onTransferError: EventEmitter<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FortShareNet');
