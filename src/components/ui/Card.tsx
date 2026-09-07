import React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';

interface Props extends ViewProps {
  /** 0 = flat with a hairline border, 1-3 = raised. */
  elevation?: 0 | 1 | 2 | 3;
  padded?: boolean;
  /** Uses the alt surface, for a card nested inside another card. */
  nested?: boolean;
}

/** The standard raised surface: rounded, bordered, theme-aware (§40). */
export function Card({
  elevation = 1,
  padded = true,
  nested = false,
  style,
  ...rest
}: Props) {
  const theme = useTheme();

  const base: ViewStyle = {
    backgroundColor: nested ? theme.colors.surfaceAlt : theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...(padded ? { padding: theme.spacing.lg } : {}),
    ...(elevation > 0 ? theme.shadow(elevation as 1 | 2 | 3) : {}),
  };

  return <View {...rest} style={[base, style]} />;
}
