import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Camera,
  useCameraDevice,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useTheme } from '../theme';
import { Button, Card, EmptyState, Icon, Screen, Text } from '../components/ui';
import { parseQr, rememberScannedPsk } from '../network/pairing/qr';
import { DeviceDiscovery } from '../native';
import { SessionManager } from '../network/session/SessionManager';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { useDeviceStore, useUiStore } from '../store';
import { requestCameraAccess } from '../services/permissions';
import type { RootStackParamList } from '../navigation/types';
import type { QrPayload } from '../models/protocol';
import { PROTOCOL_VERSION } from '../constants/protocol';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * "Scan QR" (§14).
 *
 * On a successful scan we hold the pre-shared key, then dial the device. The
 * handshake sends an HMAC over the transcript proving we saw the code, and the
 * other side pins our key without prompting its user — the "Accept/Reject"
 * step is replaced by the fact that someone physically pointed a camera at it.
 */
export function QrScanScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const toast = useUiStore((state) => state.toast);
  const setConnecting = useDeviceStore((state) => state.setConnecting);

  const device = useCameraDevice('back');
  const [permission, setPermission] = useState<'checking' | 'granted' | 'denied'>(
    'checking',
  );
  const [pairing, setPairing] = useState(false);
  /** Guards against the scanner firing repeatedly on the same code. */
  const handled = useRef(false);

  useEffect(() => {
    void requestCameraAccess().then((granted) =>
      setPermission(granted ? 'granted' : 'denied'),
    );
  }, []);

  const pair = useCallback(
    async (payload: QrPayload) => {
      setPairing(true);
      setConnecting(payload.deviceId, true);
      try {
        // Held so the handshake can prove we saw this code.
        rememberScannedPsk(payload.deviceId, payload.psk, payload.exp);

        /**
         * The code describes a network of its own: join it first.
         *
         * The other device had no network to share, so it brought up its own
         * Wi-Fi Direct group and put the credentials in the code. Joining is
         * an ordinary Wi-Fi connection — nothing for the other user to accept
         * — and once we are on it, everything below is unchanged: same dial,
         * same handshake, same encryption.
         */
        if (payload.ssid && payload.pass) {
          toast(`Joining ${payload.deviceName}'s network…`);
          const host = await DiscoveryService.joinDirectGroup(
            payload.ssid,
            payload.pass,
          );
          await SessionManager.connect({
            deviceId: payload.deviceId,
            deviceName: payload.deviceName,
            platform: payload.platform,
            deviceType: payload.deviceType,
            fingerprint: payload.fingerprint,
            protocolVersion: payload.v,
            // The group owner is where the listener is, whatever the code
            // said — we now know the network we are actually on.
            host,
            hosts: [host, payload.host],
            port: payload.port,
            discoveredAt: Date.now(),
          });

          await useDeviceStore.getState().refreshHistory();
          toast(`Paired with ${payload.deviceName}`, 'success');
          navigation.replace('DeviceDetail', { deviceId: payload.deviceId });
          return;
        }

        // Warn before spending 10 seconds on a connection that cannot work.
        // Two devices "both on 192.168.1.x" is the confusing case; two devices
        // on visibly different subnets is worth saying out loud immediately.
        const candidates = payload.hosts?.length
          ? payload.hosts
          : [payload.host];
        const info = await DeviceDiscovery.getNetworkInfo().catch(() => null);
        const mine = info?.addresses
          .filter((entry) => entry.kind !== 'cellular' && entry.kind !== 'vpn')
          .map((entry) => entry.address) ?? [];

        // A subnet mismatch is a *hint*, never a veto. Reachability really
        // depends on the netmask and on whether anything bridges the two
        // networks, and refusing here would block pairings that would have
        // worked. So: say what looks wrong, then try anyway.
        if (mine.length > 0 && !candidates.some((host) => sharesSubnet(host, mine))) {
          toast(
            `${payload.deviceName} looks like it is on a different network (${candidates[0]}). Trying anyway — if it fails, put both devices on the same Wi-Fi or share a hotspot.`,
          );
        }

        await SessionManager.connect({
          deviceId: payload.deviceId,
          deviceName: payload.deviceName,
          platform: payload.platform,
          deviceType: payload.deviceType,
          fingerprint: payload.fingerprint,
          protocolVersion: payload.v,
          host: candidates[0] ?? payload.host,
          hosts: candidates,
          port: payload.port,
          discoveredAt: Date.now(),
        });

        await useDeviceStore.getState().refreshHistory();
        toast(`Paired with ${payload.deviceName}`, 'success');
        navigation.replace('DeviceDetail', { deviceId: payload.deviceId });
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'Could not pair with that device',
          'error',
        );
        // Allow another attempt rather than stranding the user on a dead screen.
        handled.current = false;
      } finally {
        setPairing(false);
        setConnecting(payload.deviceId, false);
      }
    },
    [navigation, toast, setConnecting],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (handled.current || pairing) return;

      for (const code of codes) {
        if (!code.value) continue;
        const result = parseQr(code.value);

        if (!result.ok) {
          // The camera sees every barcode in view; only complain about codes
          // that were clearly meant to be FortShare codes.
          if (result.reason === 'expired') {
            handled.current = true;
            toast('That code has expired — ask for a new one', 'error');
            setTimeout(() => {
              handled.current = false;
            }, 2000);
          } else if (result.reason === 'version') {
            handled.current = true;
            toast(
              `That device speaks a different FortShare version (this app is v${PROTOCOL_VERSION})`,
              'error',
            );
          }
          continue;
        }

        handled.current = true;
        void pair(result.payload);
        return;
      }
    },
  });

  if (permission === 'denied') {
    return (
      <Screen title="Scan QR">
        <EmptyState
          icon="scan"
          title="Camera access needed"
          message="FortShare uses the camera only to read a pairing QR code. You can enable it in your device settings."
          tone="error"
          actionLabel="Go back"
          onAction={() => navigation.goBack()}
        />
      </Screen>
    );
  }

  if (permission === 'checking') {
    return (
      <Screen title="Scan QR">
        <EmptyState icon="scan" title="Preparing camera" message="One moment…" />
      </Screen>
    );
  }

  /**
   * Permission granted but no camera exists.
   *
   * The iOS Simulator has no camera at all, and so do some tablets and
   * kiosk-style devices. Previously this fell into the "Preparing camera"
   * branch and sat there forever, which reads as a hang rather than as an
   * unavailable feature — and pointed at the wrong thing entirely.
   */
  if (!device) {
    return (
      <Screen title="Scan QR">
        <EmptyState
          icon="scan"
          title="No camera available"
          message="This device has no usable camera, so a QR code cannot be scanned. On a simulator this is expected — use a physical device to test pairing, or have the other device scan your code instead."
          tone="error"
          actionLabel="Show my QR instead"
          onAction={() => navigation.replace('QrShow')}
        />
      </Screen>
    );
  }

  return (
    <Screen title="Scan QR" subtitle="Point at the other device's code">
      <Card padded={false} elevation={2} style={{ overflow: 'hidden' }}>
        <View style={{ aspectRatio: 1, position: 'relative' }}>
          <Camera
            style={{ flex: 1 }}
            device={device}
            isActive={!pairing}
            codeScanner={codeScanner}
          />

          {/* Reticle */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: '14%',
              left: '14%',
              right: '14%',
              bottom: '14%',
              borderWidth: 2,
              borderColor: theme.colors.accent,
              borderRadius: theme.radius.lg,
            }}
          />

          {pairing ? (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: theme.colors.scrim,
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.spacing.md,
              }}
            >
              <Icon name="shield" size={30} color="#FFFFFF" />
              <Text variant="subheading" style={{ color: '#FFFFFF' }}>
                Pairing securely…
              </Text>
            </View>
          ) : null}
        </View>
      </Card>

      <Card style={{ marginTop: theme.spacing.lg }}>
        <View
          style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}
        >
          <Icon name="shield" size={16} color={theme.colors.textFaint} />
          <Text variant="caption" tone="faint" style={{ flex: 1 }}>
            Scanning verifies the other device's identity through the camera
            rather than over the network, so nobody on your Wi-Fi can
            impersonate it. Once paired, it is remembered — you will not need
            to scan again.
          </Text>
        </View>
      </Card>

      <Button
        label="Cancel"
        variant="secondary"
        block
        onPress={() => navigation.goBack()}
        style={{ marginTop: theme.spacing.lg }}
      />
    </Screen>
  );
}

/**
 * Whether `host` looks like it is on the same /24 as any of our addresses.
 *
 * A heuristic, not a routing decision: real reachability depends on the subnet
 * mask, and two different networks can share a /24. It is only used to fail
 * *fast* with a clear message, never to refuse an otherwise valid attempt on a
 * matching subnet.
 */
function sharesSubnet(host: string, mine: string[]): boolean {
  const prefix = (address: string): string => {
    const parts = address.split('.');
    return parts.length === 4 ? parts.slice(0, 3).join('.') : '';
  };
  const target = prefix(host);
  if (!target) return true; // not an IPv4 literal — let the connection decide
  return mine.some((address) => prefix(address) === target);
}
