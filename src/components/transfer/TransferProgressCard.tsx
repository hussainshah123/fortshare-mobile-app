import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Button, Card, Icon, ProgressBar, Text } from '../ui';
import type { ActiveTransfer } from '../../models/transfer';
import {
  formatBytes,
  formatEta,
  formatSpeed,
  percentOf,
  truncateMiddle,
} from '../../utils/format';

interface Props {
  transfer: ActiveTransfer;
  /** Cipher in force, so the UI never implies protection that is absent. */
  cipher?: string;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  compact?: boolean;
}

/**
 * The live transfer card (§21).
 *
 *   Sending to Samsung S25
 *   12 files · 3.4 GB
 *   ████████████░░░░  72%
 *   Speed 22.4 MB/s   ETA 24 sec
 *   Current: Vacation.mp4   720 MB / 1.2 GB
 *   [Pause] [Cancel]
 */
export function TransferProgressCard({
  transfer,
  cipher,
  onPause,
  onResume,
  onCancel,
  compact = false,
}: Props) {
  const theme = useTheme();
  const { record, files, speed, etaSeconds, filesCompleted } = transfer;

  const percent = percentOf(record.transferredBytes, record.totalBytes);
  const current = files.find((file) => file.fileIndex === transfer.currentFileIndex);
  const sending = record.direction === 'send';
  const paused = record.status === 'paused';

  const tone = paused ? theme.colors.warning : theme.colors.accent;

  return (
    <Card elevation={2}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          marginBottom: theme.spacing.md,
        }}
      >
        <Icon
          name={sending ? 'send' : 'download'}
          size={18}
          color={tone}
        />
        <View style={{ flex: 1 }}>
          <Text variant="subheading" numberOfLines={1}>
            {sending ? 'Sending to' : 'Receiving from'} {record.deviceName}
          </Text>
          <Text variant="caption" tone="muted">
            {record.fileCount} {record.fileCount === 1 ? 'file' : 'files'} ·{' '}
            {formatBytes(record.totalBytes)}
          </Text>
        </View>
        <Text variant="heading" style={{ color: tone }}>
          {Math.round(percent)}%
        </Text>
      </View>

      {/*
        Stated explicitly rather than assumed. Neither ShareIt nor Zapya
        encrypts payloads, so this is worth showing — and when a peer is too
        old to negotiate it, saying so plainly is better than a badge that
        quietly lies.
      */}
      {cipher ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            alignSelf: 'flex-start',
            paddingVertical: 3,
            paddingHorizontal: theme.spacing.sm,
            borderRadius: theme.radius.pill,
            marginBottom: theme.spacing.md,
            backgroundColor:
              cipher === 'none' ? theme.colors.warningSoft : theme.colors.successSoft,
          }}
        >
          <Icon
            name="shield"
            size={12}
            color={cipher === 'none' ? theme.colors.warning : theme.colors.success}
          />
          <Text
            variant="caption"
            style={{
              color:
                cipher === 'none' ? theme.colors.warning : theme.colors.success,
            }}
          >
            {cipher === 'none'
              ? 'Not encrypted — peer is on an older version'
              : 'End-to-end encrypted'}
          </Text>
        </View>
      ) : null}

      <ProgressBar percent={percent} color={tone} height={9} />

      {/*
        A paused transfer says *why* rather than just stopping, so the user
        knows whether to wait, retry, or go and turn Wi-Fi back on (§38).
      */}
      {paused ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            marginTop: theme.spacing.md,
          }}
        >
          <Icon name="alert" size={14} color={theme.colors.warning} />
          <Text variant="caption" tone="warning" style={{ flex: 1 }}>
            {pauseReasonText(record.pauseReason, record.deviceName)}
          </Text>
        </View>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: theme.spacing.md,
          }}
        >
          <Metric label="Speed" value={formatSpeed(speed)} />
          <Metric label="ETA" value={formatEta(etaSeconds)} />
          <Metric
            label="Files"
            value={`${filesCompleted} / ${record.fileCount}`}
          />
        </View>
      )}

      {!compact && current ? (
        <View
          style={{
            marginTop: theme.spacing.lg,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <Text variant="caption" tone="faint">
            Current file
          </Text>
          <Text variant="bodyMedium" numberOfLines={1} style={{ marginTop: 2 }}>
            {truncateMiddle(current.name, 34)}
          </Text>
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {formatBytes(current.transferredBytes)} of {formatBytes(current.size)}
          </Text>
        </View>
      ) : null}

      {onPause || onResume || onCancel ? (
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.lg,
          }}
        >
          {paused && onResume ? (
            <Button
              label="Resume"
              icon="play"
              onPress={onResume}
              style={{ flex: 1 }}
            />
          ) : onPause ? (
            <Button
              label="Pause"
              icon="pause"
              variant="secondary"
              onPress={onPause}
              style={{ flex: 1 }}
            />
          ) : null}
          {onCancel ? (
            <Button
              label="Cancel"
              variant="danger"
              onPress={onCancel}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text variant="caption" tone="faint">
        {label}
      </Text>
      <Text variant="bodyMedium" style={{ marginTop: 1 }}>
        {value}
      </Text>
    </View>
  );
}

export function pauseReasonText(
  reason: string | null,
  deviceName: string,
): string {
  switch (reason) {
    case 'network-lost':
      return 'Paused — this device lost its Wi-Fi connection.';
    case 'peer-unreachable':
      return `Paused — ${deviceName} is no longer reachable.`;
    case 'timeout':
      return `Paused — ${deviceName} stopped responding.`;
    case 'peer':
      return `Paused by ${deviceName}.`;
    case 'user':
      return 'Paused. Nothing already transferred is lost.';
    default:
      return 'Paused.';
  }
}
