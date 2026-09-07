import React from 'react';
import { Pressable, View } from 'react-native';
import { useTheme, MIN_TOUCH_TARGET } from '../../theme';
import { Text } from './Text';

interface Props<T extends string> {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}

/** The tab switcher used by Transfers (All/Sent/Received/Failed) and Files. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: Props<T>) {
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaceAlt,
        borderRadius: theme.radius.md,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
            style={{
              flex: 1,
              minHeight: MIN_TOUCH_TARGET - 8,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: theme.spacing.xs,
              borderRadius: theme.radius.sm + 1,
              backgroundColor: active ? theme.colors.surface : 'transparent',
              ...(active ? theme.shadow(1) : {}),
            }}
          >
            <Text variant="label" tone={active ? 'default' : 'muted'}>
              {option.label}
            </Text>
            {option.count !== undefined && option.count > 0 ? (
              <Text variant="caption" tone={active ? 'accent' : 'faint'}>
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
