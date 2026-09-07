import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon } from './Icon';
import { useUiStore } from '../../store';

/** Transient confirmations, anchored above the tab bar. */
export function Toasts() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: theme.spacing.lg,
        right: theme.spacing.lg,
        bottom: insets.bottom + 76,
        gap: theme.spacing.sm,
      }}
    >
      {toasts.map((toast) => {
        const tone =
          toast.tone === 'success'
            ? theme.colors.success
            : toast.tone === 'error'
              ? theme.colors.danger
              : theme.colors.accent;
        return (
          <Pressable
            key={toast.id}
            onPress={() => dismiss(toast.id)}
            accessibilityRole="alert"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderLeftWidth: 3,
              borderColor: theme.colors.border,
              borderLeftColor: tone,
              paddingVertical: theme.spacing.md,
              paddingHorizontal: theme.spacing.lg,
              ...theme.shadow(2),
            }}
          >
            <Icon
              name={
                toast.tone === 'success'
                  ? 'check'
                  : toast.tone === 'error'
                    ? 'alert'
                    : 'wifi'
              }
              size={16}
              color={tone}
            />
            <Text variant="body" style={{ flex: 1 }}>
              {toast.message}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
