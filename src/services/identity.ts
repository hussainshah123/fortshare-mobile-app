import { Platform as RNPlatform } from 'react-native';
import { FortShareFs } from '../native';
import type { DeviceType, LocalIdentity } from '../models/device';
import { fingerprintOf, generateIdentity, uuidV4 } from './crypto';
import { StorageKeys, storage } from './storage';

/**
 * This device's permanent identity (§5).
 *
 * Generated once, on first launch, and stable across app restarts, Wi-Fi
 * changes, IP changes, router changes and phone restarts. The display name and
 * avatar are mutable; `deviceId` and the keypair are not.
 */

let cached: LocalIdentity | null = null;

const DEFAULT_AVATARS = ['📱', '💻', '🖥️', '⚡', '🚀', '🎯', '🌊', '🔥'];

/**
 * Load the identity, creating it if this is the first launch.
 *
 * The keypair is generated in the same step as the deviceId so the two can
 * never drift apart: a deviceId without its key would be unprovable, and
 * every peer would refuse it.
 */
export async function loadIdentity(): Promise<LocalIdentity> {
  if (cached) return cached;

  const existingId = storage.getString(StorageKeys.deviceId);
  const existingEdPub = storage.getString(StorageKeys.edPublicKey);

  if (existingId && existingEdPub) {
    cached = {
      deviceId: existingId,
      deviceName: storage.getString(StorageKeys.deviceName) ?? 'FortShare Device',
      avatar: storage.getString(StorageKeys.avatar) ?? DEFAULT_AVATARS[0]!,
      platform: RNPlatform.OS === 'ios' ? 'ios' : 'android',
      deviceType:
        (storage.getString(StorageKeys.deviceType) as DeviceType | undefined) ??
        'phone',
      edPublicKey: existingEdPub,
      xPublicKey: storage.getString(StorageKeys.xPublicKey) ?? '',
      // Derived rather than stored, so a stored copy can never disagree
      // with the key it describes.
      fingerprint: fingerprintOf(existingEdPub),
      createdAt: storage.getNumber(StorageKeys.createdAt) ?? Date.now(),
    };
    return cached;
  }

  // First launch.
  const keys = generateIdentity();
  const deviceId = uuidV4();
  const now = Date.now();

  let defaultName = 'FortShare Device';
  let deviceType: DeviceType = 'phone';
  try {
    const info = await FortShareFs.deviceInfo();
    defaultName = info.defaultName || info.model || defaultName;
    deviceType = info.deviceType;
  } catch {
    // Native info is a nicety; a missing model must not block first launch.
  }

  const avatar =
    DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)]!;

  storage.setString(StorageKeys.deviceId, deviceId);
  storage.setString(StorageKeys.deviceName, defaultName);
  storage.setString(StorageKeys.avatar, avatar);
  storage.setString(StorageKeys.deviceType, deviceType);
  storage.setNumber(StorageKeys.createdAt, now);
  storage.setString(StorageKeys.edPublicKey, keys.edPublicKey);
  storage.setString(StorageKeys.edSecretKey, keys.edSecretKey);
  storage.setString(StorageKeys.xPublicKey, keys.xPublicKey);
  storage.setString(StorageKeys.xSecretKey, keys.xSecretKey);

  cached = {
    deviceId,
    deviceName: defaultName,
    avatar,
    platform: RNPlatform.OS === 'ios' ? 'ios' : 'android',
    deviceType,
    edPublicKey: keys.edPublicKey,
    xPublicKey: keys.xPublicKey,
    fingerprint: keys.fingerprint,
    createdAt: now,
  };
  return cached;
}

/** Synchronous accessor for code paths that run after startup. */
export function currentIdentity(): LocalIdentity {
  if (!cached) throw new Error('Identity used before loadIdentity() resolved');
  return cached;
}

/** The private keys. Deliberately separate so they are never spread into a payload. */
export function identitySecrets(): { edSecretKey: string; xSecretKey: string } {
  const edSecretKey = storage.getString(StorageKeys.edSecretKey);
  const xSecretKey = storage.getString(StorageKeys.xSecretKey);
  if (!edSecretKey || !xSecretKey) {
    throw new Error('Identity keys missing — storage may have been cleared');
  }
  return { edSecretKey, xSecretKey };
}

/** Renaming must not change the deviceId, so only the label is written. */
export function setDeviceName(name: string): LocalIdentity {
  const trimmed = name.trim() || 'FortShare Device';
  storage.setString(StorageKeys.deviceName, trimmed);
  cached = { ...currentIdentity(), deviceName: trimmed };
  return cached;
}

export function setAvatar(avatar: string): LocalIdentity {
  storage.setString(StorageKeys.avatar, avatar);
  cached = { ...currentIdentity(), avatar };
  return cached;
}

export const AVATAR_CHOICES = DEFAULT_AVATARS;
