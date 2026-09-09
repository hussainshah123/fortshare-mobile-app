import React from 'react';
import {
  RefreshControl,
  ScrollView,
  StatusBar,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Glow } from './Gradient';

interface Props {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  /** Wraps children in a ScrollView. Off for screens with their own list. */
  scroll?: boolean;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  /** Rendered top-right of the header. */
  action?: React.ReactNode;
  contentStyle?: ViewStyle;
}

/**
 * The page frame: safe-area insets, status-bar style, and the large title
 * every top-level screen shares.
 */
export function Screen({
  children,
  title,
  subtitle,
  scroll = false,
  onRefresh,
  refreshing = false,
  action,
  contentStyle,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const header = title ? (
    <View
      style={{
        paddingHorizontal: theme.spacing.xl,
        paddingTop: theme.spacing.sm,
        paddingBottom: theme.spacing.lg,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.spacing.md,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text variant="display">{title}</Text>
        {subtitle ? (
          <Text variant="body" tone="muted" style={{ marginTop: theme.spacing.xs }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  ) : null;

  /**
   * `flex: 1` matters on the non-scrolling path.
   *
   * Without it this wrapper is sized to its content on the vertical axis, so a
   * FlatList child has no bounded height to work with and an
   * absolutely-positioned child anchors to wherever the content happens to
   * end rather than to the screen — which clipped the file picker's
   * selection bar off the bottom.
   *
   * Inside a ScrollView it must *not* stretch, or the content cannot grow.
   */
  const body = (
    <View
      style={[
        { paddingHorizontal: theme.spacing.xl },
        scroll ? null : { flex: 1 },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/*
        Ambient light behind every screen. Two offset radial glows — brand
        violet top-left, signal cyan lower-right — at low opacity. Without
        this the background is a flat slab of one colour on every screen,
        which is what makes an app feel unfinished; with it there is a gentle
        depth gradient that content sits on top of.

        Non-interactive and absolutely positioned, so it costs no layout.
      */}
      <Glow
        size={420}
        color={theme.colors.glow}
        style={{ top: -160, left: -140 }}
      />
      <Glow
        size={320}
        color={theme.isDark ? 'rgba(42, 212, 232, 0.10)' : 'rgba(0, 151, 167, 0.07)'}
        style={{ bottom: -120, right: -110 }}
      />

      {/* Edge-to-edge is enabled app-wide, so the bar is already translucent
          and only its content style needs setting. */}
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
      <View style={{ height: insets.top }} />
      {scroll ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: theme.spacing.huge }}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void onRefresh()}
                tintColor={theme.colors.accent}
                colors={[theme.colors.accent]}
              />
            ) : undefined
          }
        >
          {header}
          {body}
        </ScrollView>
      ) : (
        <>
          {header}
          <View style={{ flex: 1 }}>{body}</View>
        </>
      )}
    </View>
  );
}

/** A titled block within a screen. */
export function Section({
  title,
  action,
  children,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  return (
    <View style={[{ marginBottom: theme.spacing.xxl }, style]}>
      {title ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: theme.spacing.md,
          }}
        >
          <Text variant="heading">{title}</Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}
