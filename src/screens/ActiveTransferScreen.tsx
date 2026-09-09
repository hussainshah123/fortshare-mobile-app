import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { SessionManager } from '../network/session/SessionManager';
import { Button, Card, EmptyState, Screen, Section, Text } from '../components/ui';
import { TransferProgressCard } from '../components/transfer/TransferProgressCard';
import { FileRow } from '../components/file/FileRow';
import { useTransferStore } from '../store';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'ActiveTransfer'>;

/**
 * The full-screen transfer view (§21).
 *
 * Once the transfer leaves the active map (completed, failed or cancelled)
 * this hands off to the detail screen, so the user lands on a permanent record
 * rather than an empty progress bar.
 */
export function ActiveTransferScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();

  const transfer = useTransferStore((state) => state.active.get(params.transferId));

  useEffect(() => {
    if (transfer) return;
    // Replace rather than push: going "back" to a finished transfer's progress
    // screen would be a dead end.
    navigation.replace('TransferDetail', { transferId: params.transferId });
  }, [transfer, navigation, params.transferId]);

  if (!transfer) {
    return (
      <Screen title="Transfer">
        <EmptyState
          icon="check"
          title="Transfer finished"
          message="Opening the details…"
        />
      </Screen>
    );
  }

  const { record, files, filesCompleted } = transfer;

  return (
    <Screen title={record.direction === 'send' ? 'Sending' : 'Receiving'} scroll>
      <View style={{ marginBottom: theme.spacing.xl }}>
        <TransferProgressCard
          transfer={transfer}
          cipher={SessionManager.session(record.deviceId)?.cipher}
          onPause={
            record.status === 'active'
              ? () => void useTransferStore.getState().pause(record.id)
              : undefined
          }
          onResume={
            record.status === 'paused'
              ? () => void useTransferStore.getState().resume(record.id)
              : undefined
          }
          onCancel={() => void useTransferStore.getState().cancel(record.id)}
        />
      </View>

      <Section title={`Files · ${filesCompleted} of ${record.fileCount} done`}>
        {files.map((file) => (
          <FileRow
            key={file.id}
            name={file.name}
            size={file.size}
            mimeType={file.mimeType}
            subtitle={
              file.status === 'completed'
                ? 'Verified'
                : file.status === 'failed'
                  ? (file.error ?? 'Failed')
                  : file.status === 'skipped'
                    ? 'Skipped'
                    : `${formatBytes(file.transferredBytes)} of ${formatBytes(file.size)}`
            }
          />
        ))}
      </Section>

      <Card>
        <Text variant="caption" tone="muted">
          You can leave this screen — the transfer keeps running and you will be
          notified when it finishes. Interrupting it is safe: nothing already
          transferred is lost, and it can be resumed.
        </Text>
      </Card>

      <Button
        label="Back to Home"
        variant="secondary"
        block
        onPress={() => navigation.navigate('Tabs', { screen: 'Home' })}
        style={{ marginTop: theme.spacing.xl }}
      />
    </Screen>
  );
}
