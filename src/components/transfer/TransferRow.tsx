import React from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, ProgressBar, Text } from '../ui';
import type { TransferRecord } from '../../models/transfer';
import {
  formatBytes,
  formatTime,
  percentOf,
  truncateMiddle,
} from '../../utils/format';
import type { IconName } from '../ui';

interface Props {
  transfer: TransferRecord;
  /** First file's name, so the row can show it rather than a count. */
  headline?: string;
  onPress: () => void;
}

/** One row in the Transfers history list (§22). */
export function TransferRow({ transfer, headline, onPress }: Props) {
  const theme = useTheme();
  const sending = transfer.direction === 'send';

  const title =
    headline ??
    (transfer.fileCount === 1
      ? '1 file'
      : `${transfer.fileCount} files`);

  const state = statusPresentation(transfer.status, theme.colors);
  const incomplete =
    transfer.status === 'paused' || transfer.status === 'active';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${state.label}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: theme.spacing.md,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfaceAlt : theme.colors.surface,
        marginBottom: theme.spacing.md,
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: state.wash,
        }}
      >
        <Icon
          name={sending ? 'send' : 'download'}
          size={17}
          color={state.color}
        />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {truncateMiddle(title, 32)}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {formatBytes(transfer.totalBytes)} ·{' '}
          {sending ? 'Sent to' : 'Received from'} {transfer.deviceName}
        </Text>

        {incomplete ? (
          <View style={{ marginTop: theme.spacing.xs }}>
            <ProgressBar
              percent={percentOf(transfer.transferredBytes, transfer.totalBytes)}
              height={5}
              color={state.color}
            />
            <Text variant="caption" tone="faint" style={{ marginTop: 3 }}>
              {formatBytes(transfer.transferredBytes)} of{' '}
              {formatBytes(transfer.totalBytes)} · {state.label}
            </Text>
          </View>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              marginTop: 1,
            }}
          >
            <Icon name={state.icon} size={12} color={state.color} />
            <Text variant="caption" style={{ color: state.color }}>
              {state.label}
            </Text>
            <Text variant="caption" tone="faint">
              · {formatTime(transfer.completedAt ?? transfer.createdAt)}
            </Text>
          </View>
        )}
      </View>

      <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
    </Pressable>
  );
}

export function statusPresentation(
  status: TransferRecord['status'],
  colors: {
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    danger: string;
    dangerSoft: string;
    accent: string;
    accentSoft: string;
    textFaint: string;
    surfaceAlt: string;
  },
): { label: string; color: string; wash: string; icon: IconName } {
  switch (status) {
    case 'completed':
      return {
        label: 'Completed',
        color: colors.success,
        wash: colors.successSoft,
        icon: 'check',
      };
    case 'active':
      return {
        label: 'In progress',
        color: colors.accent,
        wash: colors.accentSoft,
        icon: 'send',
      };
    case 'paused':
      return {
        label: 'Paused',
        color: colors.warning,
        wash: colors.warningSoft,
        icon: 'pause',
      };
    case 'failed':
      return {
        label: 'Failed',
        color: colors.danger,
        wash: colors.dangerSoft,
        icon: 'alert',
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        color: colors.textFaint,
        wash: colors.surfaceAlt,
        icon: 'close',
      };
    default:
      return {
        label: 'Pending',
        color: colors.textFaint,
        wash: colors.surfaceAlt,
        icon: 'clock',
      };
  }
}
