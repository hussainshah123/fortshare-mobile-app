import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';
import {
  darkPalette,
  duration,
  lightPalette,
  radius,
  spacing,
  typography,
  type Palette,
} from './tokens';
import { StorageKeys, storage } from '../services/storage';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface Theme {
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  duration: typeof duration;
  isDark: boolean;
  mode: ThemeMode;
  /** Platform-appropriate elevation for a raised card. */
  shadow: (level: 1 | 2 | 3) => object;
}

interface ThemeContextValue extends Theme {
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Theme on first launch.
 *
 * Defaults to dark rather than following the OS. The brand ramp and the glow
 * treatments were designed against the near-black surface, and a light-mode
 * phone would otherwise open FortShare to a near-white screen that looks
 * unfinished. "System" and "Light" remain one tap away in Settings, and an
 * explicit choice is remembered.
 */
function readStoredMode(): ThemeMode {
  const stored = storage.getString(StorageKeys.themeMode);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'dark';
}

/**
 * Provides the palette and scale to the whole tree.
 *
 * Follows the OS by default and remembers an explicit choice, so a user who
 * has picked dark stays in dark even if their phone switches at sunrise.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    // Keep following the OS while the user has not chosen explicitly.
    if (mode !== 'system') return;
    const subscription = Appearance.addChangeListener(() => undefined);
    return () => subscription.remove();
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    storage.setString(StorageKeys.themeMode, next);
    setModeState(next);
  }, []);

  const isDark = mode === 'system' ? systemScheme === 'dark' : mode === 'dark';

  const value = useMemo<ThemeContextValue>(() => {
    const colors = isDark ? darkPalette : lightPalette;
    return {
      colors,
      spacing,
      radius,
      typography,
      duration,
      isDark,
      mode,
      setMode,
      shadow: (level) => shadowFor(level, isDark),
    };
  }, [isDark, mode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
  return value;
}

/**
 * Elevation.
 *
 * Dark surfaces get a *weaker* shadow, not a stronger one: on a near-black
 * ground a heavy shadow just smears, so separation comes from the surface
 * colours instead.
 */
function shadowFor(level: 1 | 2 | 3, isDark: boolean): object {
  const opacityByLevel = isDark
    ? { 1: 0.22, 2: 0.3, 3: 0.4 }
    : { 1: 0.05, 2: 0.08, 3: 0.12 };
  const radiusByLevel = { 1: 6, 2: 14, 3: 26 };
  const offsetByLevel = { 1: 2, 2: 6, 3: 12 };

  if (Platform.OS === 'android') {
    return { elevation: level * 2 };
  }
  return {
    shadowColor: '#000',
    shadowOpacity: opacityByLevel[level],
    shadowRadius: radiusByLevel[level],
    shadowOffset: { width: 0, height: offsetByLevel[level] },
  };
}
