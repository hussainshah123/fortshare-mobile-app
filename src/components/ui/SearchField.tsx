import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from './Icon';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/** The search input used by the global search and the file picker (§29). */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  autoFocus = false,
}: Props) {
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        height: 46,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: value ? theme.colors.borderStrong : theme.colors.border,
      }}
    >
      <Icon name="search" size={18} color={theme.colors.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={placeholder}
        style={{
          flex: 1,
          ...theme.typography.body,
          color: theme.colors.text,
          // Android adds vertical padding that misaligns the row.
          paddingVertical: 0,
        }}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChange('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={10}
        >
          <Icon name="close" size={16} color={theme.colors.textFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}
