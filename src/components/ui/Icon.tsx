import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../../theme';

/**
 * A small hand-drawn icon set (§40: modern icons).
 *
 * Inline SVG paths rather than an icon font: no asset to link on either
 * platform, every glyph inherits the theme colour, and the set stays limited
 * to what the app actually uses instead of shipping a thousand unused glyphs.
 *
 * All paths are drawn on a 24x24 grid with a 2px stroke.
 */
export type IconName =
  | 'home'
  | 'devices'
  | 'transfers'
  | 'files'
  | 'settings'
  | 'send'
  | 'download'
  | 'star'
  | 'star-filled'
  | 'qr'
  | 'scan'
  | 'search'
  | 'close'
  | 'check'
  | 'chevron-right'
  | 'chevron-left'
  | 'pause'
  | 'play'
  | 'refresh'
  | 'trash'
  | 'share'
  | 'shield'
  | 'wifi'
  | 'wifi-off'
  | 'phone'
  | 'tablet'
  | 'desktop'
  | 'photo'
  | 'video'
  | 'music'
  | 'document'
  | 'archive'
  | 'apk'
  | 'file'
  | 'folder'
  | 'alert'
  | 'plus'
  | 'storage'
  | 'clock'
  | 'edit';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  /** Fills the glyph instead of stroking it. Used for active tab icons. */
  filled?: boolean;
}

export function Icon({ name, size = 22, color, filled = false }: IconProps) {
  const theme = useTheme();
  const stroke = color ?? theme.colors.text;
  const common = {
    stroke,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {glyph(name, common, stroke, filled)}
    </Svg>
  );
}

type Common = {
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  fill: string;
};

function glyph(
  name: IconName,
  c: Common,
  stroke: string,
  filled: boolean,
): React.ReactNode {
  const fill = filled ? stroke : 'none';

  switch (name) {
    case 'home':
      return (
        <>
          <Path {...c} fill={fill} d="M3 10.5 12 3l9 7.5" />
          <Path {...c} fill={fill} d="M5.5 9.5V20h13V9.5" />
        </>
      );
    case 'devices':
      return (
        <>
          <Rect {...c} fill={fill} x="2.5" y="5" width="12" height="9" rx="1.6" />
          <Rect {...c} x="15.5" y="9" width="6" height="11" rx="1.6" />
          <Path {...c} d="M6 18h5" />
        </>
      );
    case 'transfers':
      return (
        <>
          <Path {...c} d="M7 5v13" />
          <Path {...c} d="M3.5 8.5 7 5l3.5 3.5" />
          <Path {...c} d="M17 19V6" />
          <Path {...c} d="M20.5 15.5 17 19l-3.5-3.5" />
        </>
      );
    case 'files':
      return (
        <>
          <Path
            {...c}
            fill={fill}
            d="M5 4h7l2.5 3H19a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
          />
        </>
      );
    case 'settings':
      return (
        <>
          <Circle {...c} cx="12" cy="12" r="3" />
          <Path
            {...c}
            d="M12 2.8v2.4M12 18.8v2.4M4.5 7.5l2 1.2M17.5 15.3l2 1.2M4.5 16.5l2-1.2M17.5 8.7l2-1.2"
          />
        </>
      );
    case 'send':
      return <Path {...c} d="M4 12h13M12 6l6 6-6 6" />;
    case 'download':
      return (
        <>
          <Path {...c} d="M12 4v11" />
          <Path {...c} d="M7.5 10.5 12 15l4.5-4.5" />
          <Path {...c} d="M4.5 19h15" />
        </>
      );
    case 'star':
    case 'star-filled':
      return (
        <Path
          {...c}
          fill={name === 'star-filled' ? stroke : 'none'}
          d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.8-5.3-2.9-5.3 2.9 1.1-5.8-4.3-4.1 5.9-.8L12 3.6Z"
        />
      );
    case 'qr':
      return (
        <>
          <Rect {...c} x="3.5" y="3.5" width="6" height="6" rx="1.2" />
          <Rect {...c} x="14.5" y="3.5" width="6" height="6" rx="1.2" />
          <Rect {...c} x="3.5" y="14.5" width="6" height="6" rx="1.2" />
          <Path {...c} d="M14.5 14.5h3M20.5 14.5v3M17.5 20.5h3M14.5 17.5v3" />
        </>
      );
    case 'scan':
      return (
        <>
          <Path {...c} d="M4 8.5V6a2 2 0 0 1 2-2h2.5" />
          <Path {...c} d="M20 8.5V6a2 2 0 0 0-2-2h-2.5" />
          <Path {...c} d="M4 15.5V18a2 2 0 0 0 2 2h2.5" />
          <Path {...c} d="M20 15.5V18a2 2 0 0 1-2 2h-2.5" />
          <Path {...c} d="M4 12h16" />
        </>
      );
    case 'search':
      return (
        <>
          <Circle {...c} cx="11" cy="11" r="6.5" />
          <Path {...c} d="m16 16 4 4" />
        </>
      );
    case 'close':
      return <Path {...c} d="M6 6l12 12M18 6 6 18" />;
    case 'check':
      return <Path {...c} d="m5 12.5 4.5 4.5L19 7.5" />;
    case 'chevron-right':
      return <Path {...c} d="m9.5 5 7 7-7 7" />;
    case 'chevron-left':
      return <Path {...c} d="m14.5 5-7 7 7 7" />;
    case 'pause':
      return (
        <>
          <Rect {...c} fill={stroke} x="7" y="5" width="3.4" height="14" rx="1.1" />
          <Rect {...c} fill={stroke} x="13.6" y="5" width="3.4" height="14" rx="1.1" />
        </>
      );
    case 'play':
      return <Path {...c} fill={stroke} d="M8 5.5l10 6.5-10 6.5v-13Z" />;
    case 'refresh':
      return (
        <>
          <Path {...c} d="M20 11a8 8 0 1 0-2.5 6.4" />
          <Path {...c} d="M20 4.5V11h-6.2" />
        </>
      );
    case 'trash':
      return (
        <>
          <Path {...c} d="M4.5 7h15" />
          <Path {...c} d="M9.5 7V4.8h5V7" />
          <Path {...c} d="M6.5 7l1 12.2h9l1-12.2" />
        </>
      );
    case 'share':
      return (
        <>
          <Path {...c} d="M12 3.5v11" />
          <Path {...c} d="M8 7.5 12 3.5l4 4" />
          <Path {...c} d="M5.5 13v6a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-6" />
        </>
      );
    case 'shield':
      return (
        <Path
          {...c}
          fill={fill}
          d="M12 3.2 19 6v5.4c0 4.2-2.8 7.4-7 9.4-4.2-2-7-5.2-7-9.4V6l7-2.8Z"
        />
      );
    case 'wifi':
      return (
        <>
          <Path {...c} d="M2.8 8.6a14 14 0 0 1 18.4 0" />
          <Path {...c} d="M6.2 12.4a9 9 0 0 1 11.6 0" />
          <Path {...c} d="M9.4 16a4.4 4.4 0 0 1 5.2 0" />
          <Circle {...c} fill={stroke} cx="12" cy="19.4" r="1.1" />
        </>
      );
    case 'wifi-off':
      return (
        <>
          <Path {...c} d="M6.2 12.4a9 9 0 0 1 6-2.4" />
          <Path {...c} d="M9.4 16a4.4 4.4 0 0 1 5.2 0" />
          <Path {...c} d="M4 4l16 16" />
        </>
      );
    case 'phone':
      return (
        <>
          <Rect {...c} x="6.5" y="2.8" width="11" height="18.4" rx="2.4" />
          <Path {...c} d="M10.5 18.4h3" />
        </>
      );
    case 'tablet':
      return (
        <>
          <Rect {...c} x="4" y="3" width="16" height="18" rx="2.2" />
          <Path {...c} d="M10.5 18h3" />
        </>
      );
    case 'desktop':
      return (
        <>
          <Rect {...c} x="2.5" y="4.5" width="19" height="12" rx="1.8" />
          <Path {...c} d="M8 20h8M12 16.5V20" />
        </>
      );
    case 'photo':
      return (
        <>
          <Rect {...c} x="3.5" y="4.5" width="17" height="15" rx="2.2" />
          <Circle {...c} cx="9" cy="9.8" r="1.7" />
          <Path {...c} d="m4.5 17 4.8-4.4 4 3.4 2.6-2.2 3.6 3.2" />
        </>
      );
    case 'video':
      return (
        <>
          <Rect {...c} x="2.8" y="5.5" width="12.4" height="13" rx="2.2" />
          <Path {...c} d="m15.2 11 6-3.2v8.4l-6-3.2v-2Z" />
        </>
      );
    case 'music':
      return (
        <>
          <Circle {...c} cx="7" cy="17.5" r="2.6" />
          <Circle {...c} cx="17.6" cy="15.4" r="2.6" />
          <Path {...c} d="M9.6 17.5V7l10.6-2.4v10.8" />
        </>
      );
    case 'document':
      return (
        <>
          <Path {...c} d="M6 3h7l5 5v13H6V3Z" />
          <Path {...c} d="M13 3v5h5" />
          <Path {...c} d="M9 13h6M9 16.5h6" />
        </>
      );
    case 'archive':
      return (
        <>
          <Rect {...c} x="3.5" y="4.5" width="17" height="15" rx="2" />
          <Path {...c} d="M3.5 9h17" />
          <Path {...c} d="M11 12h2v3h-2z" />
        </>
      );
    case 'apk':
      return (
        <>
          <Rect {...c} x="4" y="4" width="16" height="16" rx="3.4" />
          <Path {...c} d="M9 10.5h6M9 14h3.5" />
        </>
      );
    case 'file':
      return (
        <>
          <Path {...c} d="M6 3h7l5 5v13H6V3Z" />
          <Path {...c} d="M13 3v5h5" />
        </>
      );
    case 'folder':
      return (
        <Path
          {...c}
          fill={fill}
          d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.4h7.5a1.5 1.5 0 0 1 1.5 1.5v9.6a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V6.5Z"
        />
      );
    case 'alert':
      return (
        <>
          <Circle {...c} cx="12" cy="12" r="8.6" />
          <Path {...c} d="M12 7.8v5" />
          <Circle {...c} fill={stroke} cx="12" cy="16.1" r="1.05" />
        </>
      );
    case 'plus':
      return <Path {...c} d="M12 5.5v13M5.5 12h13" />;
    case 'storage':
      return (
        <>
          <Rect {...c} x="3" y="4.5" width="18" height="6" rx="1.8" />
          <Rect {...c} x="3" y="13.5" width="18" height="6" rx="1.8" />
          <Circle {...c} fill={stroke} cx="7.2" cy="7.5" r="0.9" />
          <Circle {...c} fill={stroke} cx="7.2" cy="16.5" r="0.9" />
        </>
      );
    case 'clock':
      return (
        <>
          <Circle {...c} cx="12" cy="12" r="8.6" />
          <Path {...c} d="M12 7.4V12l3.4 2" />
        </>
      );
    case 'edit':
      return (
        <>
          <Path {...c} d="M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z" />
        </>
      );
    default:
      return null;
  }
}

/** Icon for a peer's form factor, used throughout the device lists. */
export function deviceIconName(deviceType: string): IconName {
  if (deviceType === 'tablet') return 'tablet';
  if (deviceType === 'desktop') return 'desktop';
  return 'phone';
}
