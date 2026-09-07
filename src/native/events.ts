import type { EventSubscription } from 'react-native';
import type { ControlMessage } from '../models/protocol';
import type { DiscoveredPeer } from '../models/device';

/**
 * Native events arrive as JSON strings (see the spec files for why). These
 * helpers parse them once, at the boundary, so nothing above this layer ever
 * handles a raw string or an `any`.
 */

export interface PeerLostEvent {
  deviceId: string;
}
export interface DiscoveryErrorEvent {
  message: string;
}
export interface NetworkChangedEvent {
  available: boolean;
  address: string;
}
export interface ConnectionEvent {
  connectionId: string;
  host: string;
  port: number;
  /** True when the peer dialled us rather than the other way round. */
  inbound: boolean;
}
export interface ControlEvent {
  connectionId: string;
  message: ControlMessage;
}
export interface DisconnectEvent {
  connectionId: string;
  reason: string;
}
export interface TransferProgressEvent {
  transferId: string;
  fileId: string;
  fileIndex: number;
  transferredBytes: number;
  totalBytes: number;
}
export interface SendCompleteEvent {
  transferId: string;
  fileId: string;
  fileIndex: number;
  transferredBytes: number;
}
export interface ReceiveCompleteEvent {
  transferId: string;
  fileId: string;
  fileIndex: number;
  transferredBytes: number;
  /** Path of the `.part` file. Renamed only once the digest is verified. */
  path: string;
}
export interface TransferErrorEvent {
  transferId: string;
  fileId: string | null;
  message: string;
  /** True when a resume can recover this — a dropped socket rather than a bad file. */
  recoverable: boolean;
}

export type NativePeerFound = DiscoveredPeer;

/**
 * Wraps a native `EventEmitter<string>` so subscribers receive a parsed,
 * typed payload. A malformed payload is logged and dropped rather than thrown,
 * because throwing inside a native event callback tears down the listener.
 */
export function typedEvent<T>(
  emitter: (handler: (value: string) => void) => EventSubscription,
  label: string,
): (handler: (payload: T) => void) => EventSubscription {
  return (handler) =>
    emitter((raw) => {
      let parsed: T;
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        console.warn(`[FortShare] dropped malformed ${label} payload`);
        return;
      }
      handler(parsed);
    });
}
