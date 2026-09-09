import React, { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  ListRow,
  RowDivider,
  Screen,
  Section,
  Text,
} from '../components/ui';
import { FileRow } from '../components/file/FileRow';
import { statusPresentation } from '../components/transfer/TransferRow';
import { transferRepository } from '../database/repositories';
import { FortShareFs } from '../native';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { useTransferStore, useUiStore } from '../store';
import type { RootStackParamList } from '../navigation/types';
import type { TransferFileRecord, TransferRecord } from '../models/transfer';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatSpeed,
} from '../utils/format';
import { useSendFlow } from '../hooks/useSendFlow';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'TransferDetail'>;

/**
 * One transfer (§24), with Send Again (§23).
 *
 * "Send Again" reuses the saved device relationship: it checks whether the
 * device is reachable, then goes straight to the picker pre-targeted at it —
 * no re-pairing, which is the whole point of keeping the pairing.
 */
export function TransferDetailScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const toast = useUiStore((state) => state.toast);
  const { ensureSession } = useSendFlow();

  const [transfer, setTransfer] = useState<TransferRecord | null>(null);
  const [files, setFiles] = useState<TransferFileRecord[]>([]);

  useEffect(() => {
    void transferRepository.find(params.transferId).then(setTransfer);
    void transferRepository.files(params.transferId).then(setFiles);
  }, [params.transferId]);

  const sendAgain = useCallback(async () => {
    if (!transfer) return;
    const peer = DiscoveryService.peer(transfer.deviceId);
    if (!peer) {
      toast(`${transfer.deviceName} is not on this network right now`, 'error');
      return;
    }
    const session = await ensureSession(transfer.deviceId, transfer.deviceName);
    if (!session) return;
    navigation.navigate('FilePicker', { deviceId: transfer.deviceId });
  }, [transfer, ensureSession, navigation, toast]);

  const resume = useCallback(async () => {
    if (!transfer) return;
    try {
      await useTransferStore.getState().resume(transfer.id);
      navigation.goBack();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not resume',
        'error',
      );
    }
  }, [transfer, navigation, toast]);

  const removeRecord = useCallback(() => {
    if (!transfer) return;
    Alert.alert(
      'Delete from history?',
      'This removes the record only. Files already received stay on your device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void useTransferStore
              .getState()
              .deleteHistory(transfer.id)
              .then(() => navigation.goBack());
          },
        },
      ],
    );
  }, [transfer, navigation]);

  const openFile = useCallback(
    async (file: TransferFileRecord) => {
      if (!file.destPath) return;
      try {
        await FortShareFs.openFile(file.destPath, file.mimeType);
      } catch {
        toast('No app on this device can open that file', 'error');
      }
    },
    [toast],
  );

  const shareFile = useCallback(
    async (file: TransferFileRecord) => {
      if (!file.destPath) return;
      await FortShareFs.shareFile(file.destPath, file.mimeType).catch(() =>
        toast('Could not share that file', 'error'),
      );
    },
    [toast],
  );

  if (!transfer) {
    return (
      <Screen title="Transfer">
        <EmptyState
          icon="alert"
          title="Transfer not found"
          message="This record is no longer in your history."
          actionLabel="Go back"
          onAction={() => navigation.goBack()}
        />
      </Screen>
    );
  }

  const state = statusPresentation(transfer.status, theme.colors);
  const sending = transfer.direction === 'send';
  const verified = files.filter((file) => file.verified === true).length;
  const deduped = files.filter((file) => file.skipReason === 'already-have');
  const savedBytes = deduped.reduce((sum, file) => sum + file.size, 0);
  const receivedFiles = files.filter(
    (file) => !sending && file.status === 'completed' && file.destPath,
  );

  return (
    <Screen title={sending ? 'Sent' : 'Received'} scroll>
      {/* Summary */}
      <Card elevation={2} style={{ marginBottom: theme.spacing.xxl }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: theme.radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: state.wash,
            }}
          >
            <Icon name={state.icon} size={20} color={state.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="heading">{state.label}</Text>
            <Text variant="body" tone="muted">
              {sending ? 'Sent to' : 'Received from'} {transfer.deviceName}
            </Text>
          </View>
        </View>

        {transfer.errorReason ? (
          <View
            style={{
              flexDirection: 'row',
              gap: theme.spacing.sm,
              marginTop: theme.spacing.md,
              padding: theme.spacing.md,
              borderRadius: theme.radius.sm,
              backgroundColor: theme.colors.dangerSoft,
            }}
          >
            <Icon name="alert" size={15} color={theme.colors.danger} />
            <Text variant="caption" tone="danger" style={{ flex: 1 }}>
              {transfer.errorReason}
            </Text>
          </View>
        ) : null}

        <View
          style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.lg }}
        >
          {transfer.status === 'paused' ? (
            <Button label="Resume" icon="play" onPress={() => void resume()} style={{ flex: 1 }} />
          ) : null}
          {sending ? (
            <Button
              label="Send Again"
              icon="send"
              variant={transfer.status === 'paused' ? 'secondary' : 'primary'}
              onPress={() => void sendAgain()}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      </Card>

      {/* Details (§24) */}
      <Section title="Details">
        <Card padded={false}>
          <ListRow label="Files" value={String(transfer.fileCount)} icon="files" />
          <RowDivider />
          <ListRow label="Size" value={formatBytes(transfer.totalBytes)} icon="storage" />
          <RowDivider />
          <ListRow
            label="Transferred"
            value={formatBytes(transfer.transferredBytes)}
            icon="transfers"
          />
          <RowDivider />
          <ListRow label="Started" value={formatDateTime(transfer.createdAt)} icon="clock" />
          {transfer.completedAt ? (
            <>
              <RowDivider />
              <ListRow
                label="Finished"
                value={formatDateTime(transfer.completedAt)}
                icon="clock"
              />
            </>
          ) : null}
          <RowDivider />
          <ListRow label="Duration" value={formatDuration(transfer.durationMs)} icon="clock" />
          <RowDivider />
          <ListRow
            label="Average speed"
            value={formatSpeed(transfer.avgSpeed)}
            icon="transfers"
          />
          <RowDivider />
          <ListRow
            label="Direction"
            value={sending ? 'Sent' : 'Received'}
            icon={sending ? 'send' : 'download'}
          />
          <RowDivider />
          {/*
            Integrity is reported as a count rather than a tick, so a partial
            verification is visible instead of being rounded up to "verified".
          */}
          <ListRow
            label="Integrity (SHA-256)"
            description={
              verified === files.length && files.length > 0
                ? 'Every file matched its digest'
                : 'Digest computed on receipt and compared'
            }
            value={`${verified} / ${files.length}`}
            icon="shield"
          />
        </Card>
      </Section>

      {/*
        Content dedup, made visible. FortShare hashes every file before
        offering it, so a duplicate is caught by content even after a rename —
        which is worth telling the user about, because it looks like the
        transfer simply went faster.
      */}
      {deduped.length > 0 ? (
        <Section title="Skipped">
          <Card>
            <View
              style={{
                flexDirection: 'row',
                gap: theme.spacing.sm,
                alignItems: 'flex-start',
              }}
            >
              <Icon name="check" size={16} color={theme.colors.success} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium">
                  {deduped.length} {deduped.length === 1 ? 'file' : 'files'} already
                  on this device
                </Text>
                <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  Matched by content, so {formatBytes(savedBytes)} never needed
                  transferring — even if the names differ.
                </Text>
              </View>
            </View>
          </Card>
        </Section>
      ) : null}

      {/* Files */}
      <Section title="Files">
        {files.map((file) => (
          <FileRow
            key={file.id}
            name={file.name}
            size={file.size}
            mimeType={file.mimeType}
            subtitle={fileSubtitle(file)}
            onPress={
              file.destPath && file.status === 'completed'
                ? () => void openFile(file)
                : undefined
            }
            right={
              file.verified === false ? (
                <Icon name="alert" size={16} color={theme.colors.danger} />
              ) : file.verified === true ? (
                <Icon name="shield" size={16} color={theme.colors.success} />
              ) : null
            }
          />
        ))}
      </Section>

      {/* Actions (§24) */}
      <Section title="Actions">
        <Card padded={false}>
          {receivedFiles.length > 0 ? (
            <>
              <ListRow
                label="Open"
                description={receivedFiles[0]?.name}
                icon="files"
                onPress={() => {
                  const first = receivedFiles[0];
                  if (first) void openFile(first);
                }}
              />
              <RowDivider />
              <ListRow
                label="Share"
                icon="share"
                onPress={() => {
                  const first = receivedFiles[0];
                  if (first) void shareFile(first);
                }}
              />
              <RowDivider />
            </>
          ) : null}
          <ListRow
            label="Delete from history"
            icon="trash"
            destructive
            onPress={removeRecord}
          />
        </Card>
      </Section>
    </Screen>
  );
}

function fileSubtitle(file: TransferFileRecord): string {
  if (file.status === 'failed') return file.error ?? 'Failed';
  if (file.status === 'skipped') {
    // Worth distinguishing: one of these saved the user time, the other was
    // their own choice.
    return file.skipReason === 'already-have'
      ? 'Already on this device — not transferred'
      : 'Skipped';
  }
  if (file.verified === true) return 'Verified';
  if (file.verified === false) return 'Integrity check failed';
  if (file.status === 'completed') return 'Completed';
  return `${formatBytes(file.transferredBytes)} transferred`;
}
