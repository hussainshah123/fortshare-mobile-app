import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../theme';
import { Button, Card, Icon, Screen, Section, Text } from '../components/ui';
import { generateQr, revokeAll } from '../network/pairing/qr';
import { useAppStore, useDeviceStore, useUiStore } from '../store';
import { DeviceDiscovery } from '../native';
import type { DirectGroup } from '../native/DeviceDiscovery';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { SessionManager } from '../network/session/SessionManager';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
import { formatFingerprint } from '../services/crypto';
import { QR_TOKEN_TTL_MS } from '../constants/protocol';

/**
 * "Generate QR" (§14).
 *
 * The code carries an address, a public key and a single-use pre-shared key
 * that expires in five minutes. Proving possession of that key over the camera
 * is what authenticates the pairing *out of band* — which is the only way to
 * be safe against a man-in-the-middle on a network you do not control.
 *
 * The code is revoked when this screen closes, so a photograph of it taken
 * afterwards is worthless.
 */
export function QrShowScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const toast = useUiStore((state) => state.toast);
  const identity = useAppStore((state) => state.identity);
  const port = useAppStore((state) => state.port);
  const localAddress = useDeviceStore((state) => state.localAddress);

  const [generation, setGeneration] = useState(0);
  const [remaining, setRemaining] = useState(QR_TOKEN_TTL_MS);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [group, setGroup] = useState<DirectGroup | null>(null);
  const [hosting, setHosting] = useState(false);

  /**
   * With no network of our own, host one.
   *
   * This is what makes the code work with no router at all: instead of
   * describing an address on a network the scanner would have to already be
   * on, this device brings up its own Wi-Fi Direct group and the code carries
   * the credentials for it. The other device joins that network and dials us
   * on it — nothing to accept here, and no internet anywhere.
   */
  useEffect(() => {
    if (localAddress) return;
    let cancelled = false;
    setHosting(true);
    void DiscoveryService.hostDirectGroup()
      .then((hosted) => {
        if (!cancelled) setGroup(hosted);
      })
      .finally(() => {
        if (!cancelled) setHosting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [localAddress]);

  // Take the group down on the way out, so the radio is not left hosting a
  // network nobody is going to join.
  useEffect(
    () => () => {
      void DiscoveryService.stopDirectGroup().catch(() => undefined);
    },
    [],
  );

  // Every address this device answers on, so the scanner can try each rather
  // than being stuck with one guess that may be on the wrong interface.
  useEffect(() => {
    void DeviceDiscovery.getNetworkInfo()
      .then((info) =>
        setCandidates(
          info.addresses
            .filter((entry) => entry.kind !== 'cellular' && entry.kind !== 'vpn')
            .map((entry) => entry.address),
        ),
      )
      .catch(() => setCandidates([]));
  }, [generation]);

  const qr = useMemo(() => {
    if (!identity || !port) return null;
    // While hosting, the group owner address is the one that will work — the
    // scanner is about to be on that network and no other.
    const primary = group?.host || localAddress || candidates[0] || '';
    if (!primary) return null;
    return generateQr(
      identity,
      primary,
      port,
      group ? [] : candidates,
      group ? { ssid: group.ssid, passphrase: group.passphrase } : undefined,
    );
    // `generation` deliberately participates so "New code" mints a fresh PSK.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, port, localAddress, candidates, group, generation]);

  useEffect(() => {
    if (!qr) return;
    const tick = setInterval(() => {
      setRemaining(Math.max(0, qr.expiresAt - Date.now()));
    }, 500);
    return () => clearInterval(tick);
  }, [qr]);

  // Burn every issued code on the way out.
  useEffect(() => () => revokeAll(), []);

  /**
   * React to being paired.
   *
   * Pairing is symmetric — both devices pin each other's key — but only the
   * device that *scanned* was getting any feedback. The device showing the
   * code sat on a QR it no longer needed, with no sign that anything had
   * happened and no way to send. So: confirm, then go to that device, where
   * "Send Files" is.
   */
  useEffect(() => {
    const unsubscribe = SessionManager.onSession((session) => {
      toast(`Paired with ${session.peer.deviceName}`, 'success');
      void useDeviceStore.getState().refreshHistory();
      revokeAll();
      navigation.replace('DeviceDetail', {
        deviceId: session.peer.deviceId,
      });
    });
    return unsubscribe;
  }, [navigation, toast]);

  const expired = remaining <= 0;
  const seconds = Math.ceil(remaining / 1000);

  return (
    <Screen title="Pair with QR" subtitle="Scan this from the other device" scroll>
      <Card elevation={2} style={{ alignItems: 'center' }}>
        {qr && !expired ? (
          <View
            style={{
              padding: theme.spacing.lg,
              borderRadius: theme.radius.lg,
              // QR codes need a light quiet zone even in dark mode.
              backgroundColor: '#FFFFFF',
            }}
          >
            <QRCode value={qr.encoded} size={224} backgroundColor="#FFFFFF" color="#000000" />
          </View>
        ) : (
          <View
            style={{
              width: 264,
              height: 264,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.colors.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.md,
            }}
          >
            <Icon name="clock" size={30} color={theme.colors.textFaint} />
            <Text variant="body" tone="muted" center>
              {hosting
                ? 'Setting up a direct connection…'
                : !port
                ? 'Waiting for the network…'
                : !qr
                ? 'No network yet — turn Wi-Fi on to share directly'
                : 'This code has expired'}
            </Text>
          </View>
        )}

        <Text
          variant={expired ? 'body' : 'bodyMedium'}
          tone={expired ? 'danger' : 'muted'}
          center
          style={{ marginTop: theme.spacing.lg }}
        >
          {expired
            ? 'Generate a new code to pair'
            : `Expires in ${seconds}s · single use`}
        </Text>

        <Button
          label="New code"
          icon="refresh"
          variant={expired ? 'primary' : 'secondary'}
          onPress={() => {
            revokeAll();
            setRemaining(QR_TOKEN_TTL_MS);
            setGeneration((value) => value + 1);
          }}
          style={{ marginTop: theme.spacing.md }}
        />
      </Card>

      {/*
        The credentials in plain text as well as in the code.

        A scanner that cannot join a network programmatically — every iPhone —
        can still be pointed at Settings > Wi-Fi with a name and a password,
        and so can anyone whose camera will not focus.
      */}
      {group ? (
        <Section title="Or join by hand">
          <Card padded={false}>
            <Row label="Network" value={group.ssid} />
            <Row label="Password" value={group.passphrase} />
          </Card>
          <Text
            variant="caption"
            tone="faint"
            style={{ marginTop: theme.spacing.sm }}
          >
            This phone is hosting its own Wi-Fi network. The other device can
            join it from Settings › Wi-Fi and then scan the code — no router
            and no internet involved.
          </Text>
        </Section>
      ) : null}

      <Section title="This device">
        <Card padded={false}>
          <Row label="Name" value={identity?.deviceName ?? '—'} />
          <Row
            label="Address"
            value={port ? `${group?.host || localAddress || 'local'}:${port}` : '—'}
          />
          <Row
            label="Security code"
            value={identity ? formatFingerprint(identity.fingerprint) : '—'}
          />
        </Card>
      </Section>

      <Card>
        <View
          style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}
        >
          <Icon name="shield" size={16} color={theme.colors.textFaint} />
          <Text variant="caption" tone="faint" style={{ flex: 1 }}>
            The code contains only what the other device needs to reach and
            verify this one, once. It is never sent to a server, it expires in
            five minutes, and it stops working the moment you leave this screen.
          </Text>
        </View>
      </Card>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Text variant="body" tone="muted">
        {label}
      </Text>
      <Text variant="bodyMedium" numberOfLines={1} style={{ maxWidth: 190 }}>
        {value}
      </Text>
    </View>
  );
}
