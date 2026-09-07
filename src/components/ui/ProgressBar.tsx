import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useTheme } from '../../theme';

interface Props {
  /** 0-100. */
  percent: number;
  height?: number;
  color?: string;
  /** Sweeps continuously when the amount of work is not yet known. */
  indeterminate?: boolean;
}

/**
 * The transfer progress bar (§21).
 *
 * Animates towards the new value rather than snapping, because progress
 * arrives in throttled ~250ms steps and a hard jump reads as stuttering.
 */
export function ProgressBar({
  percent,
  height = 8,
  color,
  indeterminate = false,
}: Props) {
  const theme = useTheme();
  const value = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const target = Math.max(0, Math.min(100, percent));

  useEffect(() => {
    if (indeterminate) return;
    Animated.timing(value, {
      toValue: target,
      duration: theme.duration.normal,
      useNativeDriver: false,
    }).start();
  }, [target, indeterminate, value, theme.duration.normal]);

  useEffect(() => {
    if (!indeterminate) return;
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: true,
      }),
    );
    sweep.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [indeterminate, sweep]);

  const fill = color ?? theme.colors.accent;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={indeterminate ? undefined : { now: Math.round(target), min: 0, max: 100 }}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.surfaceAlt,
        overflow: 'hidden',
      }}
    >
      {indeterminate ? (
        <Animated.View
          style={{
            height,
            width: '35%',
            borderRadius: height / 2,
            backgroundColor: fill,
            transform: [
              {
                translateX: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-120, 320],
                }),
              },
            ],
          }}
        />
      ) : (
        <Animated.View
          style={{
            height,
            borderRadius: height / 2,
            backgroundColor: fill,
            width: value.interpolate({
              inputRange: [0, 100],
              outputRange: ['0%', '100%'],
            }),
          }}
        />
      )}
    </View>
  );
}
