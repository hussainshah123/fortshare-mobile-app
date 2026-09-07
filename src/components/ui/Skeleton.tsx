import React, { useEffect, useRef } from 'react';
import { Animated, View, type DimensionValue } from 'react-native';
import { useTheme } from '../../theme';

/**
 * Loading placeholder (§40).
 *
 * Shown while history loads from SQLite. The shimmer is a single shared
 * opacity animation so a screen full of rows costs one animation, not twenty.
 */
export function Skeleton({
  width = '100%',
  height = 16,
  radius,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
}) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 780, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 780, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={{
        width,
        height,
        borderRadius: radius ?? theme.radius.sm,
        backgroundColor: theme.colors.skeleton,
        opacity: pulse,
      }}
    />
  );
}

/** A skeleton shaped like a device or transfer row. */
export function SkeletonRow() {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.lg,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginBottom: theme.spacing.md,
      }}
    >
      <Skeleton width={46} height={46} radius={theme.radius.md} />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <Skeleton width="58%" height={15} />
        <Skeleton width="34%" height={12} />
      </View>
    </View>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </View>
  );
}
