import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useTheme } from '../../theme';

/**
 * Expanding rings, shown while the app is browsing the network.
 *
 * This is doing real work as an interface element: mDNS discovery is
 * continuous and has no completion event, so a spinner would be wrong (it
 * implies something will finish) and a static icon would be wrong (it implies
 * nothing is happening). Rings that keep going say "still listening", which is
 * the truth.
 *
 * Three rings on a staggered loop, native-driven so it costs nothing on the
 * JS thread while a transfer is running.
 */
export function RadarPulse({
  size = 108,
  color,
  active = true,
  children,
}: {
  size?: number;
  color?: string;
  active?: boolean;
  children?: React.ReactNode;
}) {
  const theme = useTheme();
  const tint = color ?? theme.colors.signal;
  const rings = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  useEffect(() => {
    if (!active) {
      for (const ring of rings) ring.setValue(0);
      return;
    }

    const animations = rings.map((ring, index) =>
      Animated.loop(
        Animated.sequence([
          // Stagger so the rings trail each other instead of pulsing as one.
          Animated.delay(index * 700),
          Animated.timing(ring, {
            toValue: 1,
            duration: 2100,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    );

    for (const animation of animations) animation.start();
    return () => {
      for (const animation of animations) animation.stop();
    };
  }, [active, rings]);

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {rings.map((ring, index) => (
        <Animated.View
          key={index}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: tint,
            transform: [
              {
                scale: ring.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.45, 1],
                }),
              },
            ],
            // Fade as it expands, so the ring dissolves rather than clipping.
            opacity: ring.interpolate({
              inputRange: [0, 0.15, 1],
              outputRange: [0, 0.5, 0],
            }),
          }}
        />
      ))}
      {children}
    </View>
  );
}
