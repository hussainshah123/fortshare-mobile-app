import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Card,
  EmptyState,
  Screen,
  SearchField,
  Section,
  Text,
} from '../components/ui';
import { DeviceCard } from '../components/device/DeviceCard';
import { TransferRow } from '../components/transfer/TransferRow';
import { FileRow } from '../components/file/FileRow';
import { deviceListItems, useDeviceStore, useTransferStore } from '../store';
import { transferRepository } from '../database/repositories';
import type { RootStackParamList } from '../navigation/types';
import type { TransferRecord } from '../models/transfer';
import { formatBytes } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Global search (§29) across devices, transfers and received files.
 *
 * Devices and files are filtered in memory because both lists are already
 * loaded; transfers go to SQLite, where a LIKE across the transfer and file
 * tables is cheaper than pulling the whole history into JavaScript.
 */
export function SearchScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();

  const [query, setQuery] = useState('');
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);

  const devices = useDeviceStore(deviceListItems);
  const received = useTransferStore((state) => state.received);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setTransfers([]);
      return;
    }
    let cancelled = false;
    void transferRepository.search(term, 30).then((results) => {
      if (!cancelled) setTransfers(results);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const term = query.trim().toLowerCase();
  const active = term.length >= 2;

  const matchedDevices = useMemo(
    () => (active ? devices.filter((d) => d.name.toLowerCase().includes(term)) : []),
    [devices, term, active],
  );

  const matchedFiles = useMemo(
    () =>
      active
        ? received.filter((file) => file.name.toLowerCase().includes(term))
        : [],
    [received, term, active],
  );

  const openDevice = useCallback(
    (deviceId: string) => navigation.navigate('DeviceDetail', { deviceId }),
    [navigation],
  );

  const total = matchedDevices.length + transfers.length + matchedFiles.length;

  return (
    <Screen title="Search">
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Devices, transfers, files"
        autoFocus
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
        }}
      >
        {!active ? (
          <EmptyState
            icon="search"
            title="Search FortShare"
            message="Find a saved device, a past transfer, or a file you received. Everything is searched locally."
          />
        ) : total === 0 ? (
          <EmptyState
            icon="search"
            title="No results"
            message={`Nothing matches "${query.trim()}".`}
          />
        ) : (
          <>
            {matchedDevices.length > 0 ? (
              <Section title={`Devices · ${matchedDevices.length}`}>
                {matchedDevices.map((device) => (
                  <DeviceCard
                    key={device.deviceId}
                    device={device}
                    showStats
                    onPress={() => openDevice(device.deviceId)}
                  />
                ))}
              </Section>
            ) : null}

            {transfers.length > 0 ? (
              <Section title={`Transfers · ${transfers.length}`}>
                {transfers.map((transfer) => (
                  <TransferRow
                    key={transfer.id}
                    transfer={transfer}
                    onPress={() =>
                      navigation.navigate('TransferDetail', {
                        transferId: transfer.id,
                      })
                    }
                  />
                ))}
              </Section>
            ) : null}

            {matchedFiles.length > 0 ? (
              <Section title={`Files · ${matchedFiles.length}`}>
                {matchedFiles.map((file) => (
                  <FileRow
                    key={file.id}
                    name={file.name}
                    size={file.size}
                    mimeType={file.mimeType}
                    subtitle={`From ${file.deviceName}`}
                    onPress={() =>
                      navigation.navigate('TransferDetail', {
                        transferId: file.transferId,
                      })
                    }
                  />
                ))}
              </Section>
            ) : null}

            <Card>
              <View>
                <Text variant="caption" tone="muted">
                  {matchedDevices.length} devices · {transfers.length} transfers ·{' '}
                  {matchedFiles.length} files ·{' '}
                  {formatBytes(
                    matchedFiles.reduce((sum, file) => sum + file.size, 0),
                  )}
                </Text>
              </View>
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
