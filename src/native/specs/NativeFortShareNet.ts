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

  // --------------------------------------------------------------- readiness
  /**
   * What the OS still needs switched on before sharing can work.
   *
   * Returns { wifiEnabled, locationEnabled, locationRequired, hasPermission,
   * permission } JSON. Checked at launch so the app can ask once, plainly,
   * rather than failing later with an error the user cannot connect to a
   * cause.
   */
  systemReadiness(): Promise<string>;

  /**
   * Put the user where they can fix it.
   *
   * `which` is "wifi" or "location". Resolves with "enabled" when the app
   * could turn it on directly (older Android lets it), "opened" when the
   * settings screen was shown instead, and "unavailable" when neither
   * applies.
   */
  openSystemSetting(which: string): Promise<string>;

  // ------------------------------------------------------- direct group host
  /**
   * Become a Wi-Fi Direct group owner and publish credentials to join.
   *
   * Resolves with { ssid, passphrase, host } JSON. Unlike
   * `connectWifiDirect`, nothing is negotiated with a specific peer and the
   * other device shows no invitation dialog: this simply creates a real Wi-Fi
   * network that anything can join. That is what allows the whole connection
   * to be described by a QR code.
   *
   * Android only; rejects on iOS, where the equivalent (AWDL) is automatic
   * and needs no credentials.
   */
  createDirectGroup(timeoutMs: Int32): Promise<string>;

  /** Tear down a group created by `createDirectGroup`. */
  removeDirectGroup(): Promise<void>;

  /**
   * Join a Wi-Fi network by name and passphrase, and route this app over it.
   *
   * Resolves with { host } JSON — the gateway to dial, which for a Wi-Fi
   * Direct group is the owner. Android only.
   */
  joinDirectGroup(ssid: string, passphrase: string, timeoutMs: Int32): Promise<string>;

  /** Leave a network joined by `joinDirectGroup` and restore routing. */
  leaveDirectGroup(): Promise<void>;

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
  /**
   * Every nearby Wi-Fi Direct device, as
   * { peers: [{ name, address, status }] } JSON.
   *
   * These are raw P2P devices, *not* confirmed FortShare peers: Wi-Fi Direct
   * is on whenever Wi-Fi is, so a phone shows up here without running this
   * app. That is exactly what makes it useful — a group can be formed with
   * any of them, and once it is, both devices land on a 192.168.49.x network
   * where ordinary mDNS identifies whichever of them is running FortShare.
   * Requiring a P2P service record first made the whole feature depend on
   * discovery that often never arrives.
   */
  readonly onWifiDirectRawPeers: EventEmitter<string>;
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
