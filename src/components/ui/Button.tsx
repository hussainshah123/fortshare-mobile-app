import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme, MIN_TOUCH_TARGET } from '../../theme';
import { Text } from './Text';
import { Icon, type IconName } from './Icon';
import { Gradient } from './Gradient';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'lg';

interface Props {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** Stretches to fill the parent's cross axis. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

/**
 * The app's button.
 *
 * Never smaller than a 44pt touch target (§40), and `loading` disables the
 * press as well as showing a spinner — a "Send Files" tap that fires twice
 * would start two transfers.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled = false,
  loading = false,
  block = false,
  style,
  accessibilityHint,
}: Props) {
  const theme = useTheme();
  const inert = disabled || loading;

  const height = size === 'lg' ? 54 : MIN_TOUCH_TARGET + 4;

  const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary: {
      bg: theme.colors.accent,
      fg: theme.colors.textInverse,
      border: theme.colors.accent,
    },
    secondary: {
      bg: theme.colors.surfaceAlt,
      fg: theme.colors.text,
      border: theme.colors.border,
    },
    ghost: { bg: 'transparent', fg: theme.colors.accent, border: 'transparent' },
    danger: {
      bg: theme.colors.dangerSoft,
      fg: theme.colors.danger,
      border: theme.colors.dangerSoft,
    },
  };
  const tones = palette[variant];

  return (
    <Pressable
      onPress={inert ? undefined : onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={({ pressed }) => [
        {
          height,
          minWidth: MIN_TOUCH_TARGET,
          paddingHorizontal: size === 'lg' ? theme.spacing.xxl : theme.spacing.xl,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: tones.border,
          // The primary variant paints a gradient (below) over a solid base,
          // so the base only shows through while pressed.
          backgroundColor:
            variant === 'primary' && pressed ? theme.colors.accentPressed : tones.bg,
          overflow: 'hidden',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          opacity: inert ? 0.5 : pressed ? 0.9 : 1,
          ...(block ? { alignSelf: 'stretch' } : {}),
        },
        style,
      ]}
    >
      {variant === 'primary' && !inert ? (
        <Gradient
          colors={theme.colors.gradientAccent}
          direction="horizontal"
        />
      ) : null}

      {loading ? (
        <ActivityIndicator size="small" color={tones.fg} />
      ) : (
        <>
          {icon ? (
            <View>
              <Icon name={icon} size={18} color={tones.fg} />
            </View>
          ) : null}
          <Text
            variant={size === 'lg' ? 'subheading' : 'bodyMedium'}
            style={{ color: tones.fg }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
