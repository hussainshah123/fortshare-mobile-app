import type { EventSubscription } from 'react-native';
import Net from './specs/NativeFortShareNet';
import { typedEvent } from './events';
import type { ConnectionEvent, ControlEvent, DisconnectEvent } from './events';
import type { ControlMessage } from '../models/protocol';

/**
 * The TCP transport, as required by §35.
 *
 * A "connection" here is a native socket plus its frame codec. JavaScript
 * holds only an opaque `connectionId` and exchanges CONTROL frames over it;
 * bulk data is driven by {@link FileTransfer} on the same socket.
 */
export const PeerConnection = {
  /** Bind the listener. Resolves with the ephemeral port to advertise. */
  startServer(): Promise<number> {
    return Net.startServer();
  },

  stopServer(): Promise<void> {
    return Net.stopServer();
  },

  /**
   * Dial a peer. Resolves with a connectionId once the socket is open.
   *
   * `serviceRef` carries the Bonjour endpoint when discovery supplied one, so
   * iOS can let the OS resolve the service instead of us guessing an address.
   */
  connect(
    target: { host: string; port: number; serviceRef?: string },
    timeoutMs = 10_000,
  ): Promise<string> {
    return Net.connect(
      JSON.stringify({
        host: target.host,
        port: target.port,
        serviceRef: target.serviceRef ?? '',
        timeoutMs,
      }),
    );
  },

  disconnect(connectionId: string): Promise<void> {
    return Net.disconnect(connectionId);
  },

  /** Serialise and send one CONTROL frame. */
  send(connectionId: string, message: ControlMessage): Promise<void> {
    return Net.sendControl(connectionId, JSON.stringify(message));
  },

  /**
   * Hand the negotiated session key to native. Reserved for AEAD on the data
   * path; see docs/ARCHITECTURE.md §4 for why the payload is not yet encrypted.
   */
  setSessionKey(connectionId: string, keyB64: string): Promise<void> {
    return Net.setSessionKey(connectionId, keyB64);
  },

  /** Fires for both inbound and outbound sockets; `inbound` distinguishes them. */
  onConnection(handler: (event: ConnectionEvent) => void): EventSubscription {
    return typedEvent<ConnectionEvent>(Net.onConnection, 'onConnection')(handler);
  },

  onControl(handler: (event: ControlEvent) => void): EventSubscription {
    return typedEvent<ControlEvent>(Net.onControl, 'onControl')(handler);
  },

  onDisconnect(handler: (event: DisconnectEvent) => void): EventSubscription {
    return typedEvent<DisconnectEvent>(Net.onDisconnect, 'onDisconnect')(handler);
  },
};
