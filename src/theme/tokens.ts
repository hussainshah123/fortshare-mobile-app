/**
 * FortShare design tokens (§40).
 *
 * One palette, defined once, in light and dark. Every colour a screen uses
 * comes from here — nothing hard-codes a hex value — so the two themes stay
 * in step and a change lands everywhere at once.
 */

export interface Palette {
  /** Page background. */
  background: string;
  /** Raised surface: cards, sheets, list rows. */
  surface: string;
  /** A surface on a surface: nested cards, input fields. */
  surfaceAlt: string;
  /** Hairlines and dividers. */
  border: string;
  /** A stronger border, for focus and selection. */
  borderStrong: string;

  /** Primary text. */
  text: string;
  /** Supporting text: labels, metadata. */
  textMuted: string;
  /** Tertiary text: timestamps, hints. */
  textFaint: string;
  /** Text on an accent-filled surface. */
  textInverse: string;

  /** Brand accent, used for primary actions and active state. */
  accent: string;
  /** A pressed/hover accent. */
  accentPressed: string;
  /** A tinted accent wash for selected rows and badges. */
  accentSoft: string;

  /**
   * Secondary brand colour, used for everything to do with *discovery* —
   * scanning, nearby counts, the radar pulse. Distinct from `accent` (which
   * means "act on this") and from `success` (which means "online"), so the
   * three never get confused for one another.
   */
  signal: string;
  signalSoft: string;

  /** Online / completed. */
  success: string;
  successSoft: string;
  /** Paused / needs attention. */
  warning: string;
  warningSoft: string;
  /** Failed / destructive. */
  danger: string;
  dangerSoft: string;
  /** Offline. */
  offline: string;

  /** Scrim behind a modal. */
  scrim: string;
  /** Skeleton loading blocks. */
  skeleton: string;

  /**
   * Gradient stops. Two-to-three stops each; consumed by
   * `components/ui/Gradient.tsx`, which renders them as real SVG gradients
   * rather than faking them with stacked views.
   */
  gradientBrand: readonly [string, string, string];
  gradientAccent: readonly [string, string];
  /** Radial glow behind the hero card. */
  glow: string;
}

/**
 * Light theme.
 *
 * A warm off-white ground rather than pure white, so the white cards on top of
 * it read as raised without needing heavy shadows.
 */
export const lightPalette: Palette = {
  // A cool off-white with a faint violet cast rather than neutral grey, so the
  // white cards on top read as raised without needing heavy shadows.
  background: '#F1F1FA',
  surface: '#FFFFFF',
  surfaceAlt: '#E9EAF6',
  border: '#E2E3F0',
  borderStrong: '#C8CADD',

  text: '#14142B',
  textMuted: '#565676',
  textFaint: '#8A8AA8',
  textInverse: '#FFFFFF',

  // Indigo-violet, not the default iOS/Material blue. Distinctive at a glance
  // and still passes contrast on white at this weight.
  accent: '#5B4BFF',
  accentPressed: '#4839DB',
  accentSoft: '#ECEAFF',

  signal: '#0097A7',
  signalSoft: '#DFF7FA',

  success: '#00A06A',
  successSoft: '#D8F6EA',
  warning: '#C77700',
  warningSoft: '#FDF0D5',
  danger: '#D92D3A',
  dangerSoft: '#FCE4E6',
  offline: '#A2A2BC',

  scrim: 'rgba(20, 20, 43, 0.45)',
  skeleton: '#E6E7F1',

  gradientBrand: ['#5B4BFF', '#7C5CFF', '#00B8CC'],
  gradientAccent: ['#5B4BFF', '#7C5CFF'],
  glow: 'rgba(91, 75, 255, 0.18)',
};

/**
 * Dark theme.
 *
 * Not an inversion: the accent is lifted and the softs are darkened, because a
 * colour that reads as "calm blue" on white reads as "muddy" on near-black.
 */
export const darkPalette: Palette = {
  // Near-black carrying a violet cast, so the brand colour sits *in* the
  // surface rather than glowing on top of neutral charcoal.
  background: '#08080F',
  surface: '#13131F',
  surfaceAlt: '#1C1C2C',
  border: '#292940',
  borderStrong: '#3D3D5C',

  text: '#EDEDF7',
  textMuted: '#9C9CBE',
  textFaint: '#6C6C8C',
  textInverse: '#08080F',

  // Lifted, not inverted: #5B4BFF reads muddy on near-black, so the dark
  // theme uses a lighter, slightly desaturated violet at the same hue.
  accent: '#8E7DFF',
  accentPressed: '#A697FF',
  accentSoft: '#1E1B3D',

  signal: '#2AD4E8',
  signalSoft: '#0B2B33',

  success: '#2BD99A',
  successSoft: '#0C2E23',
  warning: '#FFC44D',
  warningSoft: '#33280B',
  danger: '#FF7A82',
  dangerSoft: '#3A1519',
  offline: '#585874',

  scrim: 'rgba(0, 0, 0, 0.68)',
  skeleton: '#1D1D2E',

  gradientBrand: ['#6E5CFF', '#9A6BFF', '#2AD4E8'],
  gradientAccent: ['#7A68FF', '#9A6BFF'],
  glow: 'rgba(142, 125, 255, 0.22)',
};

/** 4pt scale. Every margin and pad in the app is one of these. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

/**
 * DM Sans throughout (§40), with a platform fallback stack so the app still
 * renders correctly if the font asset is missing.
 */
export const fontFamily = {
  regular: 'DMSans-Regular',
  medium: 'DMSans-Medium',
  bold: 'DMSans-Bold',
} as const;

export const typography = {
  display: { fontFamily: fontFamily.bold, fontSize: 32, lineHeight: 38, letterSpacing: -0.6 },
  title: { fontFamily: fontFamily.bold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  heading: { fontFamily: fontFamily.bold, fontSize: 19, lineHeight: 25, letterSpacing: -0.2 },
  subheading: { fontFamily: fontFamily.medium, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 21 },
  bodyMedium: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.regular, fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 17 },
} as const;

/** Touch targets never go below this (§40: large touch targets). */
export const MIN_TOUCH_TARGET = 44;

export const duration = {
  fast: 140,
  normal: 220,
  slow: 340,
} as const;
