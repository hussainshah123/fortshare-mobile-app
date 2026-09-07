import React from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useTheme } from '../../theme';

/**
 * Real SVG gradients, rather than a stack of translucent views.
 *
 * `react-native-svg` is already a dependency (the QR code needs it), so this
 * costs nothing extra and gives a genuinely smooth ramp — layered views band
 * visibly on dark backgrounds, which is exactly where this is used.
 *
 * Absolutely positioned to fill its parent, so it sits behind content without
 * affecting layout. The parent needs `overflow: 'hidden'` and a border radius.
 */
interface GradientProps {
  /** Stops, defaulting to the brand ramp. */
  colors?: readonly string[];
  /** `diagonal` for hero surfaces, `horizontal` for thin bars. */
  direction?: 'diagonal' | 'horizontal' | 'vertical';
  opacity?: number;
  style?: ViewStyle;
}

let gradientSeq = 0;

export function Gradient({
  colors,
  direction = 'diagonal',
  opacity = 1,
  style,
}: GradientProps) {
  const theme = useTheme();
  // SVG gradient ids must be unique per instance or the first one wins
  // wherever several are mounted at once.
  const id = React.useMemo(() => `fs-grad-${(gradientSeq += 1)}`, []);
  const stops = colors ?? theme.colors.gradientBrand;

  const vector =
    direction === 'horizontal'
      ? { x1: '0', y1: '0', x2: '1', y2: '0' }
      : direction === 'vertical'
        ? { x1: '0', y1: '0', x2: '0', y2: '1' }
        : { x1: '0', y1: '0', x2: '1', y2: '1' };

  return (
    <View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity },
        style,
      ]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} {...vector}>
            {stops.map((color, index) => (
              <Stop
                key={`${id}-${index}`}
                offset={stops.length === 1 ? '0' : `${index / (stops.length - 1)}`}
                stopColor={color}
                stopOpacity="1"
              />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/**
 * A soft radial glow, used behind the local device on Home.
 *
 * Fades to fully transparent at the edge so it blends into whatever surface it
 * is on rather than showing a visible disc.
 */
export function Glow({
  color,
  size = 260,
  style,
}: {
  color?: string;
  size?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const id = React.useMemo(() => `fs-glow-${(gradientSeq += 1)}`, []);
  const tint = color ?? theme.colors.glow;

  return (
    <View pointerEvents="none" style={[{ position: 'absolute' }, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={tint} stopOpacity="1" />
            <Stop offset="1" stopColor={tint} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect
          x="0"
          y="0"
          width={size}
          height={size}
          fill={`url(#${id})`}
        />
      </Svg>
    </View>
  );
}
