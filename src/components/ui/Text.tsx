import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../../theme';

type Variant = keyof ReturnType<typeof useTheme>['typography'];
type Tone = 'default' | 'muted' | 'faint' | 'inverse' | 'accent' | 'success' | 'warning' | 'danger';

interface Props extends TextProps {
  variant?: Variant;
  tone?: Tone;
  /** Convenience for centring without a wrapper style object. */
  center?: boolean;
}

/**
 * The only text primitive in the app.
 *
 * Screens choose a semantic variant and tone rather than a font size and hex
 * value, which is what keeps DM Sans and the palette applied consistently
 * (§40) and makes the dark theme correct by construction.
 */
export function Text({
  variant = 'body',
  tone = 'default',
  center = false,
  style,
  ...rest
}: Props) {
  const theme = useTheme();

  const toneColor: Record<Tone, string> = {
    default: theme.colors.text,
    muted: theme.colors.textMuted,
    faint: theme.colors.textFaint,
    inverse: theme.colors.textInverse,
    accent: theme.colors.accent,
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
  };

  const base: TextStyle = {
    ...theme.typography[variant],
    color: toneColor[tone],
    ...(center ? { textAlign: 'center' } : {}),
  };

  return <RNText {...rest} style={[base, style]} />;
}
