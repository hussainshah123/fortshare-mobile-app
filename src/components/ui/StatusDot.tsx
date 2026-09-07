import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import type { DeviceStatus } from '../../models/device';

/**
 * The status vocabulary from §41, in one place.
 *
 *   ● Online   ○ Offline   Connecting…   Pairing…   Transferring…   Paused
 *
 * Transient states pulse; settled states do not. Colour is never the only
 * signal — every state also carries a label — so the meaning survives a
 * colour-blind reader and a greyscale screenshot.
 */
export const STATUS_LABELS: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  connecting: 'Connecting…',
  pairing: 'Pairing…',
  transferring: 'Transferring…',
  paused: 'Paused',
};

export function statusColor(
  status: DeviceStatus,
  colors: ReturnType<typeof useTheme>['colors'],
): string {
  switch (status) {
    case 'online':
      return colors.success;
    case 'transferring':
      return colors.accent;
    case 'connecting':
    case 'pairing':
      return colors.warning;
    case 'paused':
      return colors.warning;
    case 'offline':
      return colors.offline;
    default:
      return colors.offline;
  }
}

const TRANSIENT: DeviceStatus[] = ['connecting', 'pairing', 'transferring'];

export function StatusDot({
  status,
  size = 8,
}: {
  status: DeviceStatus;
  size?: number;
}) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  const animated = TRANSIENT.includes(status);

  useEffect(() => {
    if (!animated) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, pulse]);

  const color = statusColor(status, theme.colors);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        opacity: animated ? pulse : 1,
        // Offline is a hollow ring, so it differs in *shape* as well as colour.
        backgroundColor: status === 'offline' ? 'transparent' : color,
        borderWidth: status === 'offline' ? 1.6 : 0,
        borderColor: color,
      }}
    />
  );
}

/** Dot plus label — the standard way a device's state is shown. */
export function StatusBadge({
  status,
  label,
}: {
  status: DeviceStatus;
  label?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs + 2,
      }}
    >
      <StatusDot status={status} />
      <Text variant="caption" style={{ color: statusColor(status, theme.colors) }}>
        {label ?? STATUS_LABELS[status]}
      </Text>
    </View>
  );
}
