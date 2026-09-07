import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, Text } from '../ui';
import type { IconName } from '../ui';
import type { FileCategory } from '../../models/transfer';
import { categoryOf, isPreviewable } from '../../utils/files';
import { formatBytes, truncateMiddle } from '../../utils/format';

export const CATEGORY_ICONS: Record<FileCategory, IconName> = {
  photos: 'photo',
  videos: 'video',
  music: 'music',
  documents: 'document',
  apk: 'apk',
  archives: 'archive',
  other: 'file',
  folders: 'folder',
};

interface Props {
  name: string;
  size: number;
  mimeType: string;
  /** Local URI for a thumbnail, when we have one. */
  thumbnailUri?: string;
  subtitle?: string;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: React.ReactNode;
}

/**
 * A file in the picker or the Files tab.
 *
 * Images and videos get a real thumbnail (§16: file preview); everything else
 * gets a category icon rather than a grey box.
 */
export function FileRow({
  name,
  size,
  mimeType,
  thumbnailUri,
  subtitle,
  selected = false,
  onPress,
  onLongPress,
  right,
}: Props) {
  const theme = useTheme();
  const category = categoryOf(name, mimeType);
  const showThumbnail = Boolean(thumbnailUri) && isPreviewable(mimeType);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={onPress ? { selected } : undefined}
      accessibilityLabel={`${name}, ${formatBytes(size)}`}
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
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surfaceAlt,
        }}
      >
        {showThumbnail ? (
          <Image
            source={{ uri: thumbnailUri }}
            style={{ width: 44, height: 44 }}
            resizeMode="cover"
          />
        ) : (
          <Icon
            name={CATEGORY_ICONS[category]}
            size={20}
            color={theme.colors.textMuted}
          />
        )}
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {truncateMiddle(name, 32)}
        </Text>
        <Text variant="caption" tone="muted">
          {formatBytes(size)}
          {subtitle ? ` · ${subtitle}` : ''}
        </Text>
      </View>

      {right ??
        (onPress ? (
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
        ) : null)}
    </Pressable>
  );
}

/** A category tile in the picker's landing grid (§16). */
export function CategoryTile({
  category,
  label,
  count,
  onPress,
}: {
  category: FileCategory;
  label: string;
  count?: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: '30%',
        aspectRatio: 1.15,
        padding: theme.spacing.md,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: pressed ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface,
        justifyContent: 'space-between',
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.accentSoft,
        }}
      >
        <Icon
          name={CATEGORY_ICONS[category]}
          size={19}
          color={theme.colors.accent}
        />
      </View>
      <View>
        <Text variant="bodyMedium">{label}</Text>
        {count !== undefined ? (
          <Text variant="caption" tone="faint">
            {count === 0 ? 'Empty' : `${count} items`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
