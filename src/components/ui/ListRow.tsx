import React from 'react';
import { Pressable, Switch, View, type ViewStyle } from 'react-native';
import { useTheme, MIN_TOUCH_TARGET } from '../../theme';
import { Text } from './Text';
import { Icon, type IconName } from './Icon';

interface Props {
  label: string;
  value?: string;
  description?: string;
  icon?: IconName;
  onPress?: () => void;
  /** Renders a switch instead of a chevron. */
  toggle?: { value: boolean; onChange: (value: boolean) => void };
  right?: React.ReactNode;
  destructive?: boolean;
  style?: ViewStyle;
}

/** The settings/detail row: icon, label, optional value, and one affordance. */
export function ListRow({
  label,
  value,
  description,
  icon,
  onPress,
  toggle,
  right,
  destructive = false,
  style,
}: Props) {
  const theme = useTheme();
  const interactive = Boolean(onPress) && !toggle;

  const content = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: MIN_TOUCH_TARGET + 8,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: theme.radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: destructive
              ? theme.colors.dangerSoft
              : theme.colors.surfaceAlt,
          }}
        >
          <Icon
            name={icon}
            size={18}
            color={destructive ? theme.colors.danger : theme.colors.textMuted}
          />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium" tone={destructive ? 'danger' : 'default'}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {description}
          </Text>
        ) : null}
      </View>

      {value ? (
        <Text variant="body" tone="muted" numberOfLines={1} style={{ maxWidth: 150 }}>
          {value}
        </Text>
      ) : null}

      {toggle ? (
        <Switch
          value={toggle.value}
          onValueChange={toggle.onChange}
          trackColor={{
            false: theme.colors.borderStrong,
            true: theme.colors.accent,
          }}
          thumbColor={theme.colors.surface}
          accessibilityLabel={label}
        />
      ) : right ? (
        right
      ) : interactive ? (
        <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
      ) : null}
    </View>
  );

  if (!interactive) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        borderRadius: theme.radius.md,
      })}
    >
      {content}
    </Pressable>
  );
}

/** A hairline between rows, inset to line up with row text. */
export function RowDivider({ inset = 62 }: { inset?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: 1,
        marginLeft: inset,
        backgroundColor: theme.colors.border,
      }}
    />
  );
}
