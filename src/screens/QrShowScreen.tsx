import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../theme';
import { Button, Card, Icon, Screen, Section, Text } from '../components/ui';
import { generateQr, revokeAll } from '../network/pairing/qr';
import { useAppStore, useDeviceStore } from '../store';
import { DeviceDiscovery } from '../native';
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
  const identity = useAppStore((state) => state.identity);
  const port = useAppStore((state) => state.port);
  const localAddress = useDeviceStore((state) => state.localAddress);

  const [generation, setGeneration] = useState(0);
  const [remaining, setRemaining] = useState(QR_TOKEN_TTL_MS);
  const [candidates, setCandidates] = useState<string[]>([]);

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
    const primary = localAddress || candidates[0] || '';
    return generateQr(identity, primary, port, candidates);
    // `generation` deliberately participates so "New code" mints a fresh PSK.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, port, localAddress, candidates, generation]);

  useEffect(() => {
    if (!qr) return;
    const tick = setInterval(() => {
      setRemaining(Math.max(0, qr.expiresAt - Date.now()));
    }, 500);
    return () => clearInterval(tick);
  }, [qr]);

  // Burn every issued code on the way out.
  useEffect(() => () => revokeAll(), []);

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
              {port ? 'This code has expired' : 'Waiting for the network…'}
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

      <Section title="This device">
        <Card padded={false}>
          <Row label="Name" value={identity?.deviceName ?? '—'} />
          <Row
            label="Address"
            value={port ? `${localAddress || 'local'}:${port}` : '—'}
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
