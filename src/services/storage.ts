import { createMMKV } from 'react-native-mmkv';

/**
 * Hot key-value storage for identity, keys and preferences.
 *
 * MMKV rather than SQLite because these are read synchronously during the
 * first render and on every handshake, where an async round-trip would be
 * awkward. Nothing here leaves the device.
 */
const store = createMMKV({ id: 'fortshare' });

export const StorageKeys = {
  deviceId: 'identity.deviceId',
  deviceName: 'identity.deviceName',
  avatar: 'identity.avatar',
  deviceType: 'identity.deviceType',
  createdAt: 'identity.createdAt',
  edPublicKey: 'identity.edPublicKey',
  edSecretKey: 'identity.edSecretKey',
  xPublicKey: 'identity.xPublicKey',
  xSecretKey: 'identity.xSecretKey',
  themeMode: 'prefs.themeMode',
  autoAcceptFromPaired: 'prefs.autoAcceptFromPaired',
  autoResume: 'prefs.autoResume',
  notificationsEnabled: 'prefs.notificationsEnabled',
  duplicateDefault: 'prefs.duplicateDefault',
  onboarded: 'prefs.onboarded',
} as const;

export const storage = {
  getString(key: string): string | undefined {
    return store.getString(key);
  },
  setString(key: string, value: string): void {
    store.set(key, value);
  },
  getNumber(key: string): number | undefined {
    return store.getNumber(key);
  },
  setNumber(key: string, value: number): void {
    store.set(key, value);
  },
  getBoolean(key: string, fallback: boolean): boolean {
    return store.getBoolean(key) ?? fallback;
  },
  setBoolean(key: string, value: boolean): void {
    store.set(key, value);
  },
  has(key: string): boolean {
    return store.contains(key);
  },
  remove(key: string): void {
    store.remove(key);
  },
  /** Used only by "reset app data" in Settings. */
  clearAll(): void {
    store.clearAll();
  },
};
