/** The app's tokens (web/src/styles/tokens.css, scene.css), scaled for a 1920-wide frame. */
export const C = {
  accent: '#ffd60a',
  ink: '#16130c',
  ink2: '#4a4334',
  white: '#fffdf5',
  paper: '#f4f2ec',
  muted: '#6a6558',
  cut: '#c81e2f',
} as const;

/** The app draws at 1280 CSS px wide; the film is 1920. Everything from the app is multiplied by this. */
export const K = 1.5;
/** The one line weight: 3 px in the app. */
export const LINE = 3 * K;
/** Hairline of the clock ring: 2 px in the app. */
export const HAIR = 2 * K;

export const FONT = 'Bricolage';
/** Words at normal width. */
export const words = (size: number, weight = 800): React.CSSProperties => ({
  fontFamily: FONT,
  fontSize: size,
  fontWeight: weight,
  fontStretch: '100%',
  lineHeight: 1,
  letterSpacing: '-0.02em',
});
/** Every number condensed. */
export const nums = (size: number, weight = 800): React.CSSProperties => ({
  fontFamily: FONT,
  fontSize: size,
  fontWeight: weight,
  fontStretch: '75%',
  lineHeight: 1,
  letterSpacing: '-0.01em',
  fontVariantNumeric: 'tabular-nums',
});

export const W = 1920;
export const H = 1080;
export const FPS = 30;
