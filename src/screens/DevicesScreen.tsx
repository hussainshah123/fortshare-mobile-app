import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  RadarPulse,
  Screen,
  SegmentedControl,
  SkeletonList,
  Text,
} from '../components/ui';
import { DeviceCard } from '../components/device/DeviceCard';
import { deviceListItems, useDeviceStore } from '../store';
import type { RootStackParamList } from '../navigation/types';
import type { DeviceListItem } from '../models/device';
import { useSendFlow } from '../hooks/useSendFlow';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Tab = 'nearby' | 'history' | 'favorites';

/**
 * Devices (§31): Nearby, History, Favourites.
 *
 * The History tab is the differentiator — it lists every device ever
 * connected, online or not, and an online one there needs no pairing to
 * receive files (§45).
 */
export function DevicesScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { ensureSession } = useSendFlow();

  const [tab, setTab] = useState<Tab>('nearby');
  const [refreshing, setRefreshing] = useState(false);

  const devices = useDeviceStore(deviceListItems);
  const loading = useDeviceStore((state) => state.loading);
  const discovering = useDeviceStore((state) => state.discovering);
  const networkAvailable = useDeviceStore((state) => state.networkAvailable);
  const discoveryError = useDeviceStore((state) => state.discoveryError);
  const rescan = useDeviceStore((state) => state.rescan);
  const toggleFavorite = useDeviceStore((state) => state.toggleFavorite);

  const buckets = useMemo(
    () => ({
      nearby: devices.filter((device) => device.status !== 'offline'),
      history: devices.filter((device) => device.previouslyConnected),
      favorites: devices.filter((device) => device.isFavorite),
    }),
    [devices],
  );

  const visible = buckets[tab];

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([rescan(), useDeviceStore.getState().refreshHistory()]);
    setRefreshing(false);
  }, [rescan]);

  const open = useCallback(
    (device: DeviceListItem) => {
      navigation.navigate('DeviceDetail', { deviceId: device.deviceId });
      if (device.status !== 'offline') {
        void ensureSession(device.deviceId, device.name);
      }
    },
    [navigation, ensureSession],
  );

  const empty = useCallback(() => {
    if (loading) return <SkeletonList count={3} />;

    if (!networkAvailable) {
      return (
        <EmptyState
          icon="wifi-off"
          title="No Wi-Fi connection"
          message="FortShare finds devices over your local network. Join a Wi-Fi network or a phone hotspot — no internet connection is needed."
          tone="error"
        />
      );
    }

    switch (tab) {
      case 'nearby':
        return (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <RadarPulse size={132} active>
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.colors.signalSoft,
                }}
              >
                <Icon name="wifi" size={26} color={theme.colors.signal} />
              </View>
            </RadarPulse>

            <Text variant="heading" center style={{ marginTop: theme.spacing.xl }}>
              Listening for devices
            </Text>
            <Text
              variant="body"
              tone="muted"
              center
              style={{ marginTop: theme.spacing.sm, maxWidth: 300 }}
            >
              Open FortShare on another device on this same Wi-Fi and it will
              appear here on its own. No IP addresses, no codes.
            </Text>
            <Button
              label="Scan again"
              icon="refresh"
              variant="secondary"
              onPress={() => void refresh()}
              style={{ marginTop: theme.spacing.xl }}
            />
          </View>
        );
      case 'history':
        return (
          <EmptyState
            icon="devices"
            title="No devices yet"
            message="Devices you connect to are saved here permanently, so next time you can send to them in one tap."
          />
        );
      case 'favorites':
        return (
          <EmptyState
            icon="star"
            title="No favourites"
            message="Star a device to pin it to the top of your lists and to the Home screen."
          />
        );
      default:
        return null;
    }
  }, [loading, networkAvailable, tab, refresh, theme]);

  return (
    <Screen
      title="Devices"
      subtitle={
        discovering && networkAvailable
          ? 'Scanning your network…'
          : networkAvailable
            ? 'Local network'
            : 'Offline'
      }
      action={
        <View style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
          <Button label="Scan" icon="scan" variant="ghost" onPress={() => navigation.navigate('QrScan')} />
          <Button label="Refresh" icon="refresh" variant="ghost" onPress={() => void refresh()} />
        </View>
      }
    >
      <SegmentedControl<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'nearby', label: 'Nearby', count: buckets.nearby.length },
          { value: 'history', label: 'History', count: buckets.history.length },
          { value: 'favorites', label: 'Favourites', count: buckets.favorites.length },
        ]}
      />

      {discoveryError ? (
        <Card
          style={{
            marginTop: theme.spacing.md,
            borderColor: theme.colors.warning,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
          }}
          padded
        >
          <Icon name="alert" size={16} color={theme.colors.warning} />
          <Text variant="caption" tone="warning" style={{ flex: 1 }}>
            {discoveryError}
          </Text>
        </Card>
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(item) => item.deviceId}
        contentContainerStyle={{
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
        }}
        showsVerticalScrollIndicator={false}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        ListEmptyComponent={empty}
        renderItem={({ item }) => (
          <DeviceCard
            device={item}
            showStats={tab !== 'nearby'}
            onPress={() => open(item)}
            onToggleFavorite={
              item.previouslyConnected
                ? () => void toggleFavorite(item.deviceId)
                : undefined
            }
          />
        )}
      />
    </Screen>
  );
}
