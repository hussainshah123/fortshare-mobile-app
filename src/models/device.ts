/** Platform a peer runs on. Reported in the mDNS TXT record. */
export type Platform = 'android' | 'ios';

/** Coarse form factor, used for iconography only. */
export type DeviceType = 'phone' | 'tablet' | 'desktop';

/**
 * Live reachability of a peer. This is a *rendering* state derived from
 * discovery — never a lifecycle event. A device going offline must not
 * mutate or remove its history row.
 */
export type DeviceStatus =
  | 'online'
  | 'offline'
  | 'connecting'
  | 'pairing'
  | 'transferring'
  | 'paused';

/** This device's own identity. Generated once, never derived from the network. */
export interface LocalIdentity {
  /** UUID v4. Stable across restarts, IP changes, router changes. */
  deviceId: string;
  /** Mutable display name. Changing it must not change deviceId. */
  deviceName: string;
  /** Emoji avatar key. Mutable. */
  avatar: string;
  platform: Platform;
  deviceType: DeviceType;
  /** base64url Ed25519 public key — what makes deviceId unforgeable. */
  edPublicKey: string;
  /** base64url X25519 public key, for key agreement. */
  xPublicKey: string;
  /** Short, human-comparable digest of edPublicKey. */
  fingerprint: string;
  createdAt: number;
}

/**
 * A peer seen on the network right now. Keyed by deviceId from the TXT record,
 * so a peer is recognised before any connection is made.
 */
export interface DiscoveredPeer {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  deviceType: DeviceType;
  fingerprint: string;
  protocolVersion: number;
  /** Current address. Cache for faster reconnect — never identity. */
  host: string;
  /** Additional addresses to try if `host` is unreachable. */
  hosts?: string[];
  port: number;
  /** Opaque native handle used to connect on iOS without resolving by hand. */
  serviceRef?: string;
  discoveredAt: number;
}

/** A device that has successfully connected at least once. Persisted forever. */
export interface DeviceRecord {
  deviceId: string;
  name: string;
  platform: Platform;
  deviceType: DeviceType;
  avatar: string;
  firstConnectedAt: number;
  lastConnectedAt: number;
  lastSeenAt: number;
  /** Last address we saw. Refreshed on discovery; never used for identity. */
  lastKnownAddress: string | null;
  lastKnownPort: number | null;
  isFavorite: boolean;
  filesSent: number;
  filesReceived: number;
  bytesSent: number;
  bytesReceived: number;
}

/** A device record joined with its live discovery state, ready for the UI. */
export interface DeviceListItem extends DeviceRecord {
  status: DeviceStatus;
  /** True when this row came from history rather than fresh discovery. */
  previouslyConnected: boolean;
  isPaired: boolean;
  /** Present only while the peer is discoverable. */
  peer?: DiscoveredPeer;
}

/** How trust in a peer was established. */
export type PairingMethod = 'qr' | 'manual' | 'auto';

/**
 * A pinned peer identity. The presence of a row here — with a *matching*
 * public key — is what allows a silent reconnect with no prompt.
 */
export interface PairingRecord {
  deviceId: string;
  edPublicKey: string;
  xPublicKey: string;
  fingerprint: string;
  pairedAt: number;
  method: PairingMethod;
  trusted: boolean;
  revokedAt: number | null;
}
