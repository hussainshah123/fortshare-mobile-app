import React from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar, Icon, StatusBadge, Text } from '../ui';
import type { DeviceListItem } from '../../models/device';
import { formatBytes, formatRelativeTime } from '../../utils/format';

interface Props {
  device: DeviceListItem;
  onPress: () => void;
  onToggleFavorite?: () => void;
  /** Adds the transferred-bytes line. Off in dense lists. */
  showStats?: boolean;
}

/**
 * A device in any list.
 *
 * The second line is the point of the whole app: for a remembered device it
 * says "Previously connected", which is the visible promise that no pairing is
 * needed (§10, §45). For an offline one it keeps showing when it was last
 * seen, because the record survives going offline (§9).
 */
export function DeviceCard({
  device,
  onPress,
  onToggleFavorite,
  showStats = false,
}: Props) {
  const theme = useTheme();
  const online = device.status !== 'offline';

  const subtitle = device.previouslyConnected
    ? online
      ? 'Previously connected'
      : `Last seen ${formatRelativeTime(device.lastSeenAt).toLowerCase()}`
    : 'New device';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${device.name}, ${device.status}`}
      accessibilityHint={
        online ? 'Opens this device to send files' : 'Opens this device'
      }
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: pressed ? theme.colors.borderStrong : theme.colors.border,
        backgroundColor: theme.colors.surface,
        marginBottom: theme.spacing.md,
        // Offline devices stay legible but visibly recede.
        opacity: online ? 1 : 0.72,
        ...theme.shadow(1),
      })}
    >
      <Avatar
        avatar={device.avatar}
        name={device.name}
        deviceType={device.deviceType}
      />

      <View style={{ flex: 1, gap: 3 }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}
        >
          {device.isFavorite ? (
            <Icon name="star-filled" size={13} color={theme.colors.warning} />
          ) : null}
          <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
            {device.name}
          </Text>
        </View>

        <StatusBadge status={device.status} />

        <Text variant="caption" tone="faint" numberOfLines={1}>
          {subtitle}
          {device.platform ? ` · ${platformLabel(device.platform)}` : ''}
        </Text>

        {showStats && device.previouslyConnected ? (
          <Text variant="caption" tone="faint">
            {device.filesSent + device.filesReceived} transfers ·{' '}
            {formatBytes(device.bytesSent + device.bytesReceived)}
          </Text>
        ) : null}
      </View>

      {onToggleFavorite ? (
        <Pressable
          onPress={onToggleFavorite}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={
            device.isFavorite
              ? `Remove ${device.name} from favourites`
              : `Add ${device.name} to favourites`
          }
        >
          <Icon
            name={device.isFavorite ? 'star-filled' : 'star'}
            size={20}
            color={device.isFavorite ? theme.colors.warning : theme.colors.textFaint}
          />
        </Pressable>
      ) : (
        <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
      )}
    </Pressable>
  );
}

function platformLabel(platform: string): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

/** Compact chip for the Home favourites strip. */
export function DeviceChip({
  device,
  onPress,
}: {
  device: DeviceListItem;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${device.name}, ${device.status}`}
      style={({ pressed }) => ({
        width: 116,
        padding: theme.spacing.md,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: pressed ? theme.colors.borderStrong : theme.colors.border,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
        gap: theme.spacing.sm,
        opacity: device.status === 'offline' ? 0.72 : 1,
        ...theme.shadow(1),
      })}
    >
      <Avatar
        avatar={device.avatar}
        name={device.name}
        deviceType={device.deviceType}
        size={40}
      />
      <Text variant="label" numberOfLines={1} center>
        {device.name}
      </Text>
      <StatusBadge status={device.status} />
    </Pressable>
  );
}
