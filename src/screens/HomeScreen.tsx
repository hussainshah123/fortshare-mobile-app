import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { SessionManager } from '../network/session/SessionManager';
import {
  Avatar,
  Button,
  Card,
  Glow,
  Gradient,
  Icon,
  ProgressBar,
  RadarPulse,
  Screen,
  Section,
  SkeletonList,
  Text,
} from '../components/ui';
import { DeviceChip } from '../components/device/DeviceCard';
import { TransferProgressCard } from '../components/transfer/TransferProgressCard';
import { TransferRow } from '../components/transfer/TransferRow';
import {
  favoriteDevices,
  primaryTransfer,
  useAppStore,
  useDeviceStore,
  useTransferStore,
} from '../store';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes, percentOf } from '../utils/format';
import { useSendFlow } from '../hooks/useSendFlow';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * The dashboard (§30): who I am, what I can do, who I usually send to, what
 * just happened, and how much room is left.
 */
export function HomeScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { ensureSession } = useSendFlow();

  const identity = useAppStore((state) => state.identity);
  const storageInfo = useAppStore((state) => state.storage);
  const networkAvailable = useDeviceStore((state) => state.networkAvailable);
  const localAddress = useDeviceStore((state) => state.localAddress);
  const loading = useDeviceStore((state) => state.loading);
  const favorites = useDeviceStore(favoriteDevices);
  const onlineCount = useDeviceStore((state) => state.peers.size);
  const active = useTransferStore(primaryTransfer);
  const history = useTransferStore((state) => state.history);
  const rescan = useDeviceStore((state) => state.rescan);

  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      rescan(),
      useDeviceStore.getState().refreshHistory(),
      useTransferStore.getState().refreshHistory(),
      useAppStore.getState().refreshStorage(),
    ]);
    setRefreshing(false);
  }, [rescan]);

  const openDevice = useCallback(
    async (deviceId: string, deviceName: string) => {
      navigation.navigate('DeviceDetail', { deviceId });
      // Warm the connection while the user reads the detail screen, so
      // "Send Files" is instant when they tap it.
      void ensureSession(deviceId, deviceName);
    },
    [navigation, ensureSession],
  );

  return (
    <Screen
      title="FortShare"
      subtitle={
        networkAvailable
          ? `${onlineCount} ${onlineCount === 1 ? 'device' : 'devices'} nearby`
          : 'No Wi-Fi connection'
      }
      scroll
      onRefresh={refresh}
      refreshing={refreshing}
      action={
        <Button
          label="Search"
          icon="search"
          variant="ghost"
          onPress={() => navigation.navigate('Search')}
        />
      }
    >
      {/* My device — the app's one hero surface, so it carries the brand ramp. */}
      <Card
        elevation={3}
        padded={false}
        style={{
          marginBottom: theme.spacing.xxl,
          overflow: 'hidden',
          borderColor: 'transparent',
        }}
      >
        <Gradient direction="diagonal" />
        {/* Darkens the ramp just enough for white text to clear contrast. */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(8, 8, 15, 0.18)',
          }}
        />
        <Glow
          size={240}
          style={{ right: -70, top: -90 }}
          color="rgba(255,255,255,0.22)"
        />

        <View style={{ padding: theme.spacing.lg }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
            }}
          >
            {/*
              The rings say "still listening". Discovery is continuous and has
              no completion event, so a spinner would wrongly imply it ends.
            */}
            <RadarPulse
              size={68}
              active={networkAvailable}
              color="rgba(255,255,255,0.55)"
            >
              <Avatar
                avatar={identity?.avatar}
                name={identity?.deviceName ?? 'This device'}
                deviceType={identity?.deviceType}
                size={48}
              />
            </RadarPulse>

            <View style={{ flex: 1 }}>
              <Text variant="caption" style={{ color: 'rgba(255,255,255,0.72)' }}>
                My device
              </Text>
              <Text variant="heading" numberOfLines={1} style={{ color: '#FFFFFF' }}>
                {identity?.deviceName ?? 'This device'}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.xs + 2,
                  marginTop: 2,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: networkAvailable ? '#7CF5C0' : '#FFC44D',
                  }}
                />
                <Text variant="caption" style={{ color: 'rgba(255,255,255,0.9)' }}>
                  {networkAvailable ? 'Ready to share' : 'Waiting for Wi-Fi'}
                </Text>
              </View>
            </View>

            <Button
              label="Edit"
              icon="edit"
              variant="ghost"
              onPress={() => navigation.navigate('DeviceProfile')}
              style={{ backgroundColor: 'rgba(255,255,255,0.14)' }}
            />
          </View>

          <Text
            variant="caption"
            style={{
              marginTop: theme.spacing.md,
              color: 'rgba(255,255,255,0.78)',
            }}
          >
            {networkAvailable && localAddress
              ? `On this network as ${localAddress} · discoverable to other FortShare devices`
              : 'Connect to Wi-Fi or a hotspot to find nearby devices. No internet needed.'}
          </Text>
        </View>
      </Card>

      {/* Quick actions */}
      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.md,
          marginBottom: theme.spacing.xxl,
        }}
      >
        <Button
          label="Send Files"
          icon="send"
          size="lg"
          onPress={() => navigation.navigate('Tabs', { screen: 'Devices' })}
          style={{ flex: 1 }}
        />
        <Button
          label="Receive"
          icon="qr"
          size="lg"
          variant="secondary"
          onPress={() => navigation.navigate('QrShow')}
          style={{ flex: 1 }}
        />
      </View>

      {/* Live transfer */}
      {active ? (
        <Section title="In progress">
          <TransferProgressCard
            transfer={active}
            cipher={SessionManager.session(active.record.deviceId)?.cipher}
            compact
            onPause={
              active.record.status === 'active'
                ? () => void useTransferStore.getState().pause(active.record.id)
                : undefined
            }
            onResume={
              active.record.status === 'paused'
                ? () => void useTransferStore.getState().resume(active.record.id)
                : undefined
            }
          />
        </Section>
      ) : null}

      {/* Favourites (§13) */}
      {favorites.length > 0 ? (
        <Section
          title="Favourites"
          action={
            <Button
              label="All devices"
              variant="ghost"
              onPress={() => navigation.navigate('Tabs', { screen: 'Devices' })}
            />
          }
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing.md, paddingRight: theme.spacing.xl }}
          >
            {favorites.map((device) => (
              <DeviceChip
                key={device.deviceId}
                device={device}
                onPress={() => void openDevice(device.deviceId, device.name)}
              />
            ))}
          </ScrollView>
        </Section>
      ) : null}

      {/* Recent transfers */}
      <Section
        title="Recent"
        action={
          history.length > 0 ? (
            <Button
              label="See all"
              variant="ghost"
              onPress={() => navigation.navigate('Tabs', { screen: 'Transfers' })}
            />
          ) : undefined
        }
      >
        {loading ? (
          <SkeletonList count={2} />
        ) : history.length === 0 ? (
          <Card>
            <Text variant="body" tone="muted">
              No transfers yet. Once you send or receive something it will show
              up here — and the device you used stays saved so you can send to
              it again in one tap.
            </Text>
          </Card>
        ) : (
          history
            .slice(0, 3)
            .map((transfer) => (
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

      {/* Storage (§27) */}
      {storageInfo ? (
        <Section title="Storage">
          <Card>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginBottom: theme.spacing.md,
              }}
            >
              <View>
                <Text variant="caption" tone="faint">
                  Free
                </Text>
                <Text variant="heading">{formatBytes(storageInfo.freeBytes)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text variant="caption" tone="faint">
                  Used
                </Text>
                <Text variant="heading">{formatBytes(storageInfo.usedBytes)}</Text>
              </View>
            </View>
            <ProgressBar
              percent={percentOf(storageInfo.usedBytes, storageInfo.totalBytes)}
              height={7}
            />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                marginTop: theme.spacing.md,
              }}
            >
              <Icon name="storage" size={13} color={theme.colors.textFaint} />
              <Text variant="caption" tone="faint">
                {formatBytes(storageInfo.totalBytes)} total on this device
              </Text>
            </View>
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}
