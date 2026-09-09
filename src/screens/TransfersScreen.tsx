import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { SessionManager } from '../network/session/SessionManager';
import {
  EmptyState,
  Screen,
  SegmentedControl,
  Section,
  SkeletonList,
  Text,
} from '../components/ui';
import { TransferProgressCard } from '../components/transfer/TransferProgressCard';
import { TransferRow } from '../components/transfer/TransferRow';
import {
  activeTransfers,
  filteredHistory,
  historyCounts,
  useTransferStore,
  type HistoryFilter,
} from '../store';
import type { RootStackParamList } from '../navigation/types';
import type { TransferRecord } from '../models/transfer';
import { groupByDate } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Transfers (§22, §31): the live ones on top, then history grouped by day and
 * filtered by All / Sent / Received / Failed.
 */
export function TransfersScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();

  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const active = useTransferStore(activeTransfers);
  const loading = useTransferStore((state) => state.loading);
  const history = useTransferStore((state) => filteredHistory(state, filter));
  // A selector returning a fresh object literal would make the store look
  // permanently changed; `historyCounts` is memoised on the history array.
  const counts = useTransferStore(historyCounts);

  useEffect(() => {
    void useTransferStore.getState().refreshHistory();
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await useTransferStore.getState().refreshHistory();
    setRefreshing(false);
  }, []);

  const sections = useMemo(
    () =>
      groupByDate<TransferRecord>(history, (transfer) =>
        transfer.completedAt ?? transfer.createdAt,
      ),
    [history],
  );

  return (
    <Screen title="Transfers" subtitle="Stored on this device only">
      <SegmentedControl<HistoryFilter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'sent', label: 'Sent', count: counts.sent },
          { value: 'received', label: 'Received', count: counts.received },
          { value: 'failed', label: 'Failed', count: counts.failed },
        ]}
      />

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        contentContainerStyle={{
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
        }}
        ListHeaderComponent={
          active.length > 0 ? (
            <Section title="Active">
              {active.map((transfer) => (
                <View key={transfer.record.id} style={{ marginBottom: theme.spacing.md }}>
                  <TransferProgressCard
                    transfer={transfer}
                    cipher={SessionManager.session(transfer.record.deviceId)?.cipher}
                    onPause={
                      transfer.record.status === 'active'
                        ? () =>
                            void useTransferStore
                              .getState()
                              .pause(transfer.record.id)
                        : undefined
                    }
                    onResume={
                      transfer.record.status === 'paused'
                        ? () =>
                            void useTransferStore
                              .getState()
                              .resume(transfer.record.id)
                        : undefined
                    }
                    onCancel={() =>
                      void useTransferStore.getState().cancel(transfer.record.id)
                    }
                  />
                </View>
              ))}
            </Section>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <Text
            variant="label"
            tone="faint"
            style={{
              marginTop: theme.spacing.lg,
              marginBottom: theme.spacing.sm,
            }}
          >
            {section.title.toUpperCase()}
          </Text>
        )}
        renderItem={({ item }) => (
          <TransferRow
            transfer={item}
            onPress={() =>
              navigation.navigate('TransferDetail', { transferId: item.id })
            }
          />
        )}
        ListEmptyComponent={
          loading ? (
            <SkeletonList count={3} />
          ) : (
            <EmptyState
              icon="transfers"
              title={
                filter === 'failed' ? 'Nothing failed' : 'No transfers yet'
              }
              message={
                filter === 'failed'
                  ? 'Interrupted transfers show up here so you can resume them.'
                  : 'Pick a device and send something. Every transfer is recorded here, on this device only.'
              }
            />
          )
        }
      />
    </Screen>
  );
}
