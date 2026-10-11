/**
 * Palette, geometry, and value formatting for the /traffic dashboard
 * images. Colours follow the Discord dark surfaces plus a dataviz palette
 * validated against the embed background; geometry is in logical pixels
 * and every canvas is rendered at `SCALE`x for a crisp image in Discord.
 */

/** Logical canvas width; the PNG is `DASHBOARD_WIDTH_PX` wide. */
export const LOGICAL_WIDTH = 520;
export const SCALE = 2;
export const DASHBOARD_WIDTH_PX = LOGICAL_WIDTH * SCALE;

export const PAD = 16;
export const INNER_WIDTH = LOGICAL_WIDTH - 2 * PAD;
export const COLUMN_GAP = 20;
export const HALF_WIDTH = (INNER_WIDTH - COLUMN_GAP) / 2;

/** Ranked lists never show more rows than this per column. */
export const RANK_ROW_LIMIT = 10;

export const COLOR = {
  embedBg: '#2b2d31',
  tile: '#313338',
  ink: '#f2f3f5',
  body: '#dbdee1',
  muted: '#949ba4',
  grid: '#393c43',
  base: '#4e5058',
  current: '#3987e5',
  previous: '#80848e',
  up: '#0ca30c',
  down: '#f0605d',
  amber: '#e9a23b',
  violet: '#b07ae0',
  tagFill: '#393c43',
  white: '#ffffff',
} as const;

/** Colours for the segments of a stacked bar, in segment order. */
const SEGMENT_COLORS: readonly string[] = [COLOR.current, COLOR.amber, COLOR.violet];

export const segmentColor = (index: number): string =>
  SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? COLOR.current;

/** Avatar fallback colours for applications without a preloaded icon. */
const AVATAR_COLORS: readonly string[] = ['#5865f2', '#d55181', '#2f9e8f', '#c27a2c', '#7a6fd1'];

/** Sequential one-hue ramp for the heatmap; near-zero recedes into the surface. */
const RAMP: readonly (readonly [number, number, number])[] = [
  [0x33, 0x37, 0x3e],
  [0x18, 0x4f, 0x95],
  [0x2a, 0x78, 0xd6],
  [0x55, 0x98, 0xe7],
  [0x9e, 0xc5, 0xf4],
  [0xcd, 0xe2, 0xfb],
];

export const rampColor = (t: number): string => {
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const scaled = clamped * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = RAMP[i] ?? RAMP[0];
  const b = RAMP[i + 1] ?? a;
  if (a === undefined || b === undefined) return COLOR.grid;
  const mix = (k: 0 | 1 | 2): number => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
};

export const withAlpha = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Stable small hash so a name always maps to the same fallback colour. */
const nameHash = (name: string): number => {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
};

export const hueFor = (name: string): number => nameHash(name) % 360;

export const avatarColorFor = (name: string): string =>
  AVATAR_COLORS[nameHash(name) % AVATAR_COLORS.length] ?? COLOR.current;

/** Locale-neutral digit grouping (`12,345`); numbers carry no translatable words. */
export const formatCount = (n: number): string => Math.round(n).toLocaleString('en-US');

export const formatPercent = (part: number, total: number, digits = 0): string =>
  `${total > 0 ? ((part / total) * 100).toFixed(digits) : (0).toFixed(digits)}%`;
