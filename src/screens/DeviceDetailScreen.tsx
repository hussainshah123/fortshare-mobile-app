import React, { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Icon,
  ListRow,
  RowDivider,
  Screen,
  Section,
  StatusBadge,
  Text,
} from '../components/ui';
import { TransferRow } from '../components/transfer/TransferRow';
import { findDevice, useDeviceStore } from '../store';
import { transferRepository, pairingRepository } from '../database/repositories';
import type { RootStackParamList } from '../navigation/types';
import type { TransferRecord } from '../models/transfer';
import { formatBytes, formatDate, formatDateTime, pluralize } from '../utils/format';
import { formatFingerprint } from '../services/crypto';
import { useSendFlow } from '../hooks/useSendFlow';
import { SessionManager } from '../network/session/SessionManager';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'DeviceDetail'>;

/**
 * One device (§32), and the offline variant of it (§12).
 *
 * Offline is not an error state here: the statistics, the history and the
 * last-seen time are all still shown, with a Try Again rather than a dead end.
 */
export function DeviceDetailScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const { ensureSession, connecting } = useSendFlow();

  const device = useDeviceStore((state) => findDevice(state, params.deviceId));
  const toggleFavorite = useDeviceStore((state) => state.toggleFavorite);
  const removeDevice = useDeviceStore((state) => state.removeDevice);

  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  useEffect(() => {
    void transferRepository.byDevice(params.deviceId, 20).then(setTransfers);
    void pairingRepository
      .find(params.deviceId)
      .then((pairing) => setFingerprint(pairing?.fingerprint ?? null));
  }, [params.deviceId]);

  const online = device ? device.status !== 'offline' : false;
  const connected = SessionManager.isConnected(params.deviceId);

  const sendFiles = useCallback(async () => {
    if (!device) return;
    const session = await ensureSession(device.deviceId, device.name);
    if (!session) return;
    navigation.navigate('FilePicker', { deviceId: device.deviceId });
  }, [device, ensureSession, navigation]);

  const tryAgain = useCallback(async () => {
    await useDeviceStore.getState().rescan();
  }, []);

  const confirmRemove = useCallback(() => {
    if (!device) return;
    Alert.alert(
      `Remove ${device.name}?`,
      'This forgets the device and its pairing, so it will have to be approved again next time. Your transfer history is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void removeDevice(device.deviceId).then(() => navigation.goBack());
          },
        },
      ],
    );
  }, [device, removeDevice, navigation]);

  if (!device) {
    return (
      <Screen title="Device">
        <EmptyState
          icon="alert"
          title="Device not found"
          message="This device is no longer in your history."
          actionLabel="Go back"
          onAction={() => navigation.goBack()}
        />
      </Screen>
    );
  }

  const totalTransferred = device.bytesSent + device.bytesReceived;

  return (
    <Screen title={device.name} scroll>
      {/* Identity + status */}
      <Card elevation={2} style={{ marginBottom: theme.spacing.xxl }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
        >
          <Avatar
            avatar={device.avatar}
            name={device.name}
            deviceType={device.deviceType}
            size={56}
          />
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="caption" tone="faint">
              {device.platform === 'ios' ? 'iOS' : 'Android'} ·{' '}
              {device.deviceType}
            </Text>
            <StatusBadge
              status={connecting ? 'connecting' : device.status}
            />
            {device.previouslyConnected ? (
              <Text variant="caption" tone="muted">
                {online ? 'Previously connected' : 'Saved device'}
              </Text>
            ) : (
              <Text variant="caption" tone="muted">
                Not yet connected
              </Text>
            )}
          </View>
          <Button
            label="Favourite"
            icon={device.isFavorite ? 'star-filled' : 'star'}
            variant="ghost"
            onPress={() => void toggleFavorite(device.deviceId)}
          />
        </View>

        {/* Primary action, or the §12 offline treatment. */}
        {online ? (
          <Button
            label="Send Files"
            icon="send"
            size="lg"
            block
            loading={connecting}
            onPress={() => void sendFiles()}
            style={{ marginTop: theme.spacing.lg }}
          />
        ) : (
          <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.sm,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surfaceAlt,
              }}
            >
              <Icon name="clock" size={15} color={theme.colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text variant="caption" tone="faint">
                  Last seen
                </Text>
                <Text variant="bodyMedium">{formatDateTime(device.lastSeenAt)}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button
                label="Try Again"
                icon="refresh"
                onPress={() => void tryAgain()}
                style={{ flex: 1 }}
              />
              {/*
                Discovery relies on multicast, which plenty of routers drop
                even when both devices are on the same network. Scanning the
                other device's QR carries its address directly, so it is the
                reliable way in when the list stays empty.
              */}
              <Button
                label="Scan QR"
                icon="scan"
                variant="secondary"
                onPress={() => navigation.navigate('QrScan')}
                style={{ flex: 1 }}
              />
            </View>

            {/*
              Says the quiet part out loud. A saved device raises a reasonable
              expectation that you can reach it from anywhere, and FortShare
              cannot — there is no server to relay through, by design. Better
              to explain that here than to let Try Again fail repeatedly.
            */}
            <View
              style={{
                flexDirection: 'row',
                gap: theme.spacing.sm,
                alignItems: 'flex-start',
                marginTop: theme.spacing.xs,
              }}
            >
              <Icon name="wifi-off" size={15} color={theme.colors.textFaint} />
              <Text variant="caption" tone="faint" style={{ flex: 1 }}>
                {device.name} stays saved forever, and reconnects with no
                pairing the moment it is reachable again. Reachable means the
                same Wi-Fi, or one of you sharing a hotspot — FortShare sends
                files directly between devices, so it cannot reach a device on
                a different network or in another location.
              </Text>
            </View>
          </View>
        )}
      </Card>

      {/* Statistics (§28) */}
      {device.previouslyConnected ? (
        <Section title="Statistics">
          <Card padded={false}>
            <ListRow
              label="Files sent"
              value={String(device.filesSent)}
              icon="send"
            />
            <RowDivider />
            <ListRow
              label="Files received"
              value={String(device.filesReceived)}
              icon="download"
            />
            <RowDivider />
            <ListRow
              label="Total sent"
              value={formatBytes(device.bytesSent)}
              icon="transfers"
            />
            <RowDivider />
            <ListRow
              label="Total received"
              value={formatBytes(device.bytesReceived)}
              icon="transfers"
            />
            <RowDivider />
            <ListRow
              label="Data transferred"
              value={formatBytes(totalTransferred)}
              icon="storage"
            />
            <RowDivider />
            <ListRow
              label="First connected"
              value={
                device.firstConnectedAt ? formatDate(device.firstConnectedAt) : '—'
              }
              icon="clock"
            />
            <RowDivider />
            <ListRow
              label="Last connected"
              value={
                device.lastConnectedAt ? formatDateTime(device.lastConnectedAt) : '—'
              }
              icon="clock"
            />
          </Card>
        </Section>
      ) : null}

      {/* Security */}
      <Section title="Security">
        <Card padded={false}>
          <ListRow
            label="Pairing"
            value={device.isPaired ? 'Trusted' : 'Not paired'}
            icon="shield"
          />
          {fingerprint ? (
            <>
              <RowDivider />
              <ListRow
                label="Security code"
                description="Compare with the code shown on that device"
                value={formatFingerprint(fingerprint)}
                icon="qr"
              />
            </>
          ) : null}
          {connected ? (
            <>
              <RowDivider />
              <ListRow
                label="Connection"
                value="Active session"
                icon="wifi"
              />
            </>
          ) : null}
        </Card>
      </Section>

      {/* Per-device transfer history */}
      <Section title="Transfer history">
        {transfers.length === 0 ? (
          <Card>
            <Text variant="body" tone="muted">
              No transfers with this device yet.
            </Text>
          </Card>
        ) : (
          transfers.map((transfer) => (
            <TransferRow
              key={transfer.id}
              transfer={transfer}
              onPress={() =>
                navigation.navigate('TransferDetail', { transferId: transfer.id })
              }
            />
          ))
        )}
      </Section>

      {/* Destructive actions last */}
      <Section>
        <Card padded={false}>
          <ListRow
            label="Remove device"
            description={
              device.previouslyConnected
                ? `Forgets this device and ${pluralize(transfers.length, 'transfer')} stays in history`
                : 'Forgets this device'
            }
            icon="trash"
            destructive
            onPress={confirmRemove}
          />
        </Card>
      </Section>
    </Screen>
  );
}
