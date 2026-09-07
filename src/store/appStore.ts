import { create } from 'zustand';
import { FortShareFs } from '../native';
import type { StorageInfo } from '../native/FortShareFs';
import type { LocalIdentity } from '../models/device';
import { setAvatar, setDeviceName } from '../services/identity';
import { StorageKeys, storage } from '../services/storage';

export type BootPhase = 'starting' | 'ready' | 'failed';

export interface Preferences {
  /** Skip the "wants to send you files" prompt for already-paired devices. */
  autoAcceptFromPaired: boolean;
  /** Resume a paused transfer as soon as the peer reappears. */
  autoResume: boolean;
  notificationsEnabled: boolean;
}

interface AppState {
  phase: BootPhase;
  bootError: string | null;
  identity: LocalIdentity | null;
  /** Port our TCP listener bound to. Also what we advertise. */
  port: number;
  storage: StorageInfo | null;
  preferences: Preferences;

  setPhase: (phase: BootPhase, error?: string | null) => void;
  setIdentity: (identity: LocalIdentity) => void;
  setPort: (port: number) => void;
  refreshStorage: () => Promise<void>;
  rename: (name: string) => void;
  changeAvatar: (avatar: string) => void;
  setPreference: <K extends keyof Preferences>(
    key: K,
    value: Preferences[K],
  ) => void;
}

function loadPreferences(): Preferences {
  return {
    autoAcceptFromPaired: storage.getBoolean(
      StorageKeys.autoAcceptFromPaired,
      false,
    ),
    autoResume: storage.getBoolean(StorageKeys.autoResume, true),
    notificationsEnabled: storage.getBoolean(
      StorageKeys.notificationsEnabled,
      true,
    ),
  };
}

const PREFERENCE_KEYS: Record<keyof Preferences, string> = {
  autoAcceptFromPaired: StorageKeys.autoAcceptFromPaired,
  autoResume: StorageKeys.autoResume,
  notificationsEnabled: StorageKeys.notificationsEnabled,
};

export const useAppStore = create<AppState>((set) => ({
  phase: 'starting',
  bootError: null,
  identity: null,
  port: 0,
  storage: null,
  preferences: loadPreferences(),

  setPhase: (phase, error = null) => set({ phase, bootError: error }),
  setIdentity: (identity) => set({ identity }),
  setPort: (port) => set({ port }),

  refreshStorage: async () => {
    const info = await FortShareFs.storageInfo().catch(() => null);
    if (info) set({ storage: info });
  },

  /** Renaming changes the label only — never the deviceId (§5). */
  rename: (name) => set({ identity: setDeviceName(name) }),
  changeAvatar: (avatar) => set({ identity: setAvatar(avatar) }),

  setPreference: (key, value) => {
    storage.setBoolean(PREFERENCE_KEYS[key], value);
    set((state) => ({ preferences: { ...state.preferences, [key]: value } }));
  },
}));
