import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, type IconName } from './Icon';
import { Button } from './Button';

interface Props {
  icon: IconName;
  title: string;
  /** Say what to *do*, not just that the list is empty (§40). */
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: 'neutral' | 'error';
}

/** The empty and error state used by every list in the app. */
export function EmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction,
  tone = 'neutral',
}: Props) {
  const theme = useTheme();
  const accent = tone === 'error' ? theme.colors.danger : theme.colors.accent;
  const wash = tone === 'error' ? theme.colors.dangerSoft : theme.colors.accentSoft;

  return (
    <View
      style={{
        alignItems: 'center',
        paddingVertical: theme.spacing.huge,
        paddingHorizontal: theme.spacing.xl,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: theme.radius.xxl,
          backgroundColor: wash,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: theme.spacing.xl,
        }}
      >
        <Icon name={icon} size={32} color={accent} />
      </View>

      <Text variant="heading" center>
        {title}
      </Text>
      <Text
        variant="body"
        tone="muted"
        center
        style={{ marginTop: theme.spacing.sm, maxWidth: 300 }}
      >
        {message}
      </Text>

      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant="secondary"
          style={{ marginTop: theme.spacing.xl }}
        />
      ) : null}
    </View>
  );
}
