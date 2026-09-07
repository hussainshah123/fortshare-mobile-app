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
