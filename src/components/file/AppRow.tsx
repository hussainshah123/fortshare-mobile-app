import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, Text } from '../ui';
import { formatBytes } from '../../utils/format';

/**
 * An installed app in the picker.
 *
 * Shows the real launcher icon, because a list of APK filenames is not how
 * anyone recognises their own apps.
 */
export function AppRow({
  name,
  packageName,
  versionName,
  size,
  iconPath,
  selected,
  onPress,
}: {
  name: string;
  packageName: string;
  versionName: string;
  size: number;
  iconPath: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const label = name.replace(/\.apk$/i, '');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}, ${formatBytes(size)}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.accentSoft
          : pressed
            ? theme.colors.surfaceAlt
            : theme.colors.surface,
        marginBottom: theme.spacing.sm,
      })}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surfaceAlt,
          overflow: 'hidden',
        }}
      >
        {iconPath ? (
          <Image
            source={{ uri: `file://${iconPath}` }}
            style={{ width: 36, height: 36 }}
            resizeMode="contain"
          />
        ) : (
          <Icon name="apk" size={20} color={theme.colors.textMuted} />
        )}
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {label}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {formatBytes(size)}
          {versionName ? ` · v${versionName}` : ''}
        </Text>
        <Text variant="caption" tone="faint" numberOfLines={1}>
          {packageName}
        </Text>
      </View>

      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: selected ? 0 : 1.6,
          borderColor: theme.colors.borderStrong,
          backgroundColor: selected ? theme.colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          <Icon name="check" size={13} color={theme.colors.textInverse} />
        ) : null}
      </View>
    </Pressable>
  );
}

/** A track in the picker, shown by title and artist rather than filename. */
export function TrackRow({
  title,
  artist,
  album,
  size,
  durationMs,
  selected,
  onPress,
}: {
  title: string;
  artist: string;
  album: string;
  size: number;
  durationMs: number;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  const duration = (() => {
    if (!durationMs || durationMs <= 0) return '';
    const total = Math.round(durationMs / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  })();

  const subtitle = [artist || album, duration, formatBytes(size)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}${artist ? ` by ${artist}` : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.accentSoft
          : pressed
            ? theme.colors.surfaceAlt
            : theme.colors.surface,
        marginBottom: theme.spacing.sm,
      })}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.signalSoft,
        }}
      >
        <Icon name="music" size={20} color={theme.colors.signal} />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: selected ? 0 : 1.6,
          borderColor: theme.colors.borderStrong,
          backgroundColor: selected ? theme.colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          <Icon name="check" size={13} color={theme.colors.textInverse} />
        ) : null}
      </View>
    </Pressable>
  );
}
