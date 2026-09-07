import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  darkPalette,
  fontFamily,
  lightPalette,
  radius,
  spacing,
  typography,
} from '../theme/tokens';

interface Props {
  children: React.ReactNode;
  isDark: boolean;
  /** Called on "Try again", to re-run whatever failed. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * The last line of defence (§49).
 *
 * Deliberately uses React Native's own primitives and raw tokens — not this
 * app's `Text`/`Button`, and not `useTheme`. Those all read the theme context,
 * which lives *inside* the tree this boundary is protecting: if the provider
 * or anything above it throws, a themed error screen would throw too, and the
 * real error would be replaced by "useTheme must be used inside a
 * ThemeProvider". An error boundary that can itself fail is not one.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Local only — there is no crash reporter to send this to, by design.
    console.error('[FortShare] unhandled error', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const colors = this.props.isDark ? darkPalette : lightPalette;

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          padding: spacing.xl,
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing.xl,
            gap: spacing.md,
          }}
        >
          <Text
            style={{
              ...typography.title,
              color: colors.text,
            }}
          >
            Something went wrong
          </Text>
          <Text style={{ ...typography.body, color: colors.textMuted }}>
            FortShare hit an unexpected error. Your devices, pairings and
            transfer history are stored on this device and are unaffected.
          </Text>

          <ScrollView
            style={{
              maxHeight: 200,
              backgroundColor: colors.surfaceAlt,
              borderRadius: radius.sm,
              padding: spacing.md,
            }}
          >
            <Text
              style={{
                fontFamily: fontFamily.regular,
                fontSize: 12,
                lineHeight: 17,
                color: colors.textMuted,
              }}
            >
              {error.message || String(error)}
            </Text>
          </ScrollView>

          <Pressable
            onPress={this.reset}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => ({
              height: 48,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? colors.accentPressed : colors.accent,
            })}
          >
            <Text
              style={{
                ...typography.subheading,
                color: colors.textInverse,
              }}
            >
              Try again
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }
}
