import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, deviceIconName } from './Icon';
import type { DeviceType } from '../../models/device';

interface Props {
  /** Emoji avatar, if the device has one. */
  avatar?: string;
  name: string;
  deviceType?: DeviceType;
  size?: number;
  /** Tints the background with the accent, for the local device. */
  highlight?: boolean;
}

/**
 * A device's avatar.
 *
 * Falls back through emoji → initials → form-factor icon, so a device with no
 * avatar and an unhelpful name still gets something recognisable rather than
 * an empty circle.
 */
export function Avatar({
  avatar,
  name,
  deviceType = 'phone',
  size = 46,
  highlight = false,
}: Props) {
  const theme = useTheme();

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2.6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: highlight ? theme.colors.accentSoft : theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: highlight ? theme.colors.accent : theme.colors.border,
      }}
    >
      {avatar ? (
        <Text style={{ fontSize: size * 0.46 }}>{avatar}</Text>
      ) : initials ? (
        <Text
          variant="bodyMedium"
          style={{
            fontSize: size * 0.34,
            color: highlight ? theme.colors.accent : theme.colors.textMuted,
          }}
        >
          {initials}
        </Text>
      ) : (
        <Icon
          name={deviceIconName(deviceType)}
          size={size * 0.5}
          color={theme.colors.textMuted}
        />
      )}
    </View>
  );
}
