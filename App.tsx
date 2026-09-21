/**
 * FortShare — backendless peer-to-peer file sharing.
 *
 * There is no server anywhere in this app. Files travel directly between two
 * devices over the local network, and every record — devices, pairings,
 * transfers, statistics — lives in SQLite on the device that created it.
 *
 * See docs/ARCHITECTURE.md for the protocol and the reasoning behind it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './src/theme';
import { BootSplash, RootNavigator } from './src/navigation/RootNavigator';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { Toasts } from './src/components/ui';
import {
  DuplicatePrompt,
  IncomingTransferPrompt,
  PairingPrompt,
  ReadinessPrompt,
} from './src/components/prompts';
import { startFortShare, stopFortShare } from './src/services/bootstrap';
import { useAppStore } from './src/store';

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const [attempt, setAttempt] = useState(0);

  return (
    <ErrorBoundary isDark={isDark} onReset={() => setAttempt((n) => n + 1)}>
      <SafeAreaProvider>
        <ThemeProvider>
          <FortShareRoot key={attempt} />
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

/**
 * Starts the stack, then renders.
 *
 * Nothing is rendered until the database is open and the identity exists,
 * because every screen assumes both — and the listener has to be bound before
 * discovery can advertise the port it is listening on.
 */
function FortShareRoot() {
  const theme = useTheme();
  const phase = useAppStore((state) => state.phase);
  const bootError = useAppStore((state) => state.bootError);

  useEffect(() => {
    void startFortShare();
    return () => {
      void stopFortShare();
    };
  }, []);

  const retry = useCallback(() => {
    useAppStore.getState().setPhase('starting');
    void startFortShare();
  }, []);


  const navigationTheme = {
    ...(theme.isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.isDark ? DarkTheme : DefaultTheme).colors,
      primary: theme.colors.accent,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.accent,
    },
  };

  if (phase === 'starting') {
    return <BootSplash message="Starting up…" />;
  }

  if (phase === 'failed') {
    return (
      <BootSplash
        message={bootError ?? 'FortShare could not start'}
        actionLabel="Try again"
        onAction={retry}
      />
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      <RootNavigator />

      {/*
        Prompts live above the navigator, not inside a screen: the networking
        layer can be blocked on one of these at any moment, whatever screen the
        user happens to be looking at.
      */}
      <PairingPrompt />
      <IncomingTransferPrompt />
      <DuplicatePrompt />
      {/*
        Last, so a live pairing or transfer request is never covered by a
        setup prompt the user can answer at leisure.
      */}
      <ReadinessPrompt />
      <Toasts />
    </NavigationContainer>
  );
}
