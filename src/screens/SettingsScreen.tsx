import React, { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, type ThemeMode } from '../theme';
import {
  Avatar,
  Button,
  Card,
  ListRow,
  ProgressBar,
  RowDivider,
  Screen,
  Section,
  SegmentedControl,
  Text,
} from '../components/ui';
import {
  useAppStore,
  useDeviceStore,
  useTransferStore,
  useUiStore,
  transferStats,
} from '../store';
import { deviceRepository } from '../database/repositories';
import type { RootStackParamList } from '../navigation/types';
import { PROTOCOL_VERSION, SERVICE_TYPE } from '../constants/protocol';
import { formatBytes, formatDate, percentOf } from '../utils/format';
import { formatFingerprint } from '../services/crypto';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Settings (§31): device, security, appearance, notifications, storage, about. */
export function SettingsScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const toast = useUiStore((state) => state.toast);

  const identity = useAppStore((state) => state.identity);
  const port = useAppStore((state) => state.port);
  const storageInfo = useAppStore((state) => state.storage);
  const preferences = useAppStore((state) => state.preferences);
  const setPreference = useAppStore((state) => state.setPreference);

  const localAddress = useDeviceStore((state) => state.localAddress);
  const deviceCount = useDeviceStore((state) => state.history.length);
  const stats = useTransferStore(transferStats);
  const clearHistory = useTransferStore((state) => state.clearHistory);

  const [aggregate, setAggregate] = useState({ bytesSent: 0, bytesReceived: 0 });

  useEffect(() => {
    void deviceRepository.aggregateStats().then((totals) =>
      setAggregate({
        bytesSent: totals.bytesSent,
        bytesReceived: totals.bytesReceived,
      }),
    );
  }, []);

  const confirmClearHistory = useCallback(() => {
    Alert.alert(
      'Clear transfer history?',
      'Removes every transfer record. Your saved devices, pairings and the files themselves are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void clearHistory().then(() => toast('Transfer history cleared'));
          },
        },
      ],
    );
  }, [clearHistory, toast]);

  return (
    <Screen title="Settings" scroll>
      {/* Device identity (§5) */}
      <Section title="My device">
        <Card>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
          >
            <Avatar
              avatar={identity?.avatar}
              name={identity?.deviceName ?? 'This device'}
              deviceType={identity?.deviceType}
              size={52}
              highlight
            />
            <View style={{ flex: 1 }}>
              <Text variant="heading" numberOfLines={1}>
                {identity?.deviceName ?? 'This device'}
              </Text>
              <Text variant="caption" tone="muted">
                {identity?.platform === 'ios' ? 'iOS' : 'Android'} ·{' '}
                {identity?.deviceType}
              </Text>
            </View>
            <Button
              label="Edit"
              variant="secondary"
              onPress={() => navigation.navigate('DeviceProfile')}
            />
          </View>
          <Text variant="caption" tone="faint" style={{ marginTop: theme.spacing.md }}>
            Renaming this device does not change its identity — other devices
            will still recognise it as the same one.
          </Text>
        </Card>
      </Section>

      {/* Security (§42) */}
      <Section title="Security">
        <Card padded={false}>
          <ListRow
            label="Security code"
            description="Share this to let someone verify they paired with you"
            value={
              identity ? formatFingerprint(identity.fingerprint).slice(0, 9) + '…' : '—'
            }
            icon="shield"
          />
          <RowDivider />
          <ListRow
            label="Show pairing QR"
            description="Let a new device pair without approving a prompt"
            icon="qr"
            onPress={() => navigation.navigate('QrShow')}
          />
          <RowDivider />
          <ListRow
            label="Scan pairing QR"
            icon="scan"
            onPress={() => navigation.navigate('QrScan')}
          />
          <RowDivider />
          <ListRow
            label="Auto-accept from paired devices"
            description="Skip the approval prompt — only ever applies to devices you have already paired with"
            icon="check"
            toggle={{
              value: preferences.autoAcceptFromPaired,
              onChange: (value) => setPreference('autoAcceptFromPaired', value),
            }}
          />
        </Card>
      </Section>

      {/* Transfers */}
      <Section title="Transfers">
        <Card padded={false}>
          <ListRow
            label="Resume automatically"
            description="Pick up an interrupted transfer as soon as the device is back"
            icon="refresh"
            toggle={{
              value: preferences.autoResume,
              onChange: (value) => setPreference('autoResume', value),
            }}
          />
          <RowDivider />
          <ListRow
            label="Notifications"
            description="Progress, completion and incoming transfers"
            icon="alert"
            toggle={{
              value: preferences.notificationsEnabled,
              onChange: (value) => setPreference('notificationsEnabled', value),
            }}
          />
        </Card>
      </Section>

      {/* Appearance (§40) */}
      <Section title="Appearance">
        <Card>
          <Text variant="label" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
            Theme
          </Text>
          <SegmentedControl<ThemeMode>
            value={theme.mode}
            onChange={theme.setMode}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Card>
      </Section>

      {/* Storage (§27) */}
      <Section title="Storage">
        <Card>
          {storageInfo ? (
            <>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginBottom: theme.spacing.md,
                }}
              >
                <View>
                  <Text variant="caption" tone="faint">
                    Used
                  </Text>
                  <Text variant="subheading">
                    {formatBytes(storageInfo.usedBytes)}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text variant="caption" tone="faint">
                    Free
                  </Text>
                  <Text variant="subheading">
                    {formatBytes(storageInfo.freeBytes)}
                  </Text>
                </View>
              </View>
              <ProgressBar
                percent={percentOf(storageInfo.usedBytes, storageInfo.totalBytes)}
                height={7}
              />
            </>
          ) : (
            <Text variant="body" tone="muted">
              Storage information unavailable.
            </Text>
          )}
        </Card>

        <Card padded={false} style={{ marginTop: theme.spacing.md }}>
          <ListRow label="Files sent" value={String(stats.filesSent)} icon="send" />
          <RowDivider />
          <ListRow
            label="Files received"
            value={String(stats.filesReceived)}
            icon="download"
          />
          <RowDivider />
          <ListRow
            label="Total data transferred"
            value={formatBytes(aggregate.bytesSent + aggregate.bytesReceived)}
            icon="transfers"
          />
          <RowDivider />
          <ListRow label="Saved devices" value={String(deviceCount)} icon="devices" />
        </Card>
      </Section>

      {/* Data */}
      <Section title="Data">
        <Card padded={false}>
          <ListRow
            label="Clear transfer history"
            description="Keeps your devices, pairings and files"
            icon="trash"
            destructive
            onPress={confirmClearHistory}
          />
        </Card>
      </Section>

      {/* About (§1: state the no-backend guarantee plainly) */}
      <Section title="About">
        <Card padded={false}>
          <ListRow label="Version" value="1.0.0" icon="shield" />
          <RowDivider />
          <ListRow label="Protocol" value={`v${PROTOCOL_VERSION}`} icon="transfers" />
          <RowDivider />
          <ListRow label="Service" value={SERVICE_TYPE} icon="wifi" />
          <RowDivider />
          <ListRow
            label="Listening on"
            value={port ? `${localAddress || 'this device'}:${port}` : '—'}
            icon="devices"
          />
          <RowDivider />
          <ListRow
            label="Identity created"
            value={identity ? formatDate(identity.createdAt) : '—'}
            icon="clock"
          />
        </Card>

        {/* <Card style={{ marginTop: theme.spacing.md }}>
          <Text variant="bodyMedium">No account. No server. No cloud.</Text>
          <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.xs }}>
            FortShare has no backend. Files travel directly from one device to
            the other over your local network, and your devices, pairings and
            history are stored only on this device. Everything here works with
            the internet switched off.
          </Text>
        </Card> */}
      </Section>
    </Screen>
  );
}
