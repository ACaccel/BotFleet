/**
 * Shared canvas constants, axis-scale maths, and small drawing helpers for
 * the /traffic charts. All user-facing text is passed in already
 * translated, so this module and its siblings hold no CJK literals.
 */
import { AttachmentBuilder } from 'discord.js';
import { createCanvas, type Canvas, type CanvasRenderingContext2D } from 'canvas';
import { canvasFont, ensureCanvasFont } from '../../../infra/graphics/canvas-font';

export const TIME_CHART_FILE = 'traffic-time.png';
export const CHANNELS_CHART_FILE = 'traffic-channels.png';
export const USERS_CHART_FILE = 'traffic-users.png';

export const WIDTH = 900;
const BG = '#2f3136';
export const FG = '#ffffff';
export const MUTED = '#b5bac1';
export const GRID = '#3a3d44';
export const TRACK = '#383a40';
export const ACCENT = '#5865f2';
export const ACCENT_EDGE = '#7c88ff';

export interface ChartRow {
  readonly label: string;
  readonly value: number;
}

/** Everything the chart renderers need, assembled by `view.ts`. */
export interface TrafficChartData {
  readonly total: number;
  readonly timeTitle: string;
  readonly timeYAxisLabel: string;
  readonly timePoints: readonly ChartRow[];
  readonly channelsTitle: string;
  readonly channelRows: readonly ChartRow[];
  readonly usersTitle: string;
  readonly userRows: readonly ChartRow[];
}

const niceNum = (range: number, round: boolean): number => {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction = 10;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
  }
  return niceFraction * 10 ** exponent;
};

/**
 * ~`maxTicks` evenly spaced integer "nice" ticks over `[0, max]`. Returns a
 * `1`-step `[0, 1]` axis when `max <= 0` so an all-zero window still draws a
 * sensible baseline.
 */
export const niceTicks = (
  max: number,
  maxTicks = 5,
): { readonly niceMax: number; readonly ticks: readonly number[] } => {
  if (!Number.isFinite(max) || max <= 0) return { niceMax: 1, ticks: [0, 1] };
  const range = niceNum(max, false);
  const step = Math.max(1, Math.round(niceNum(range / (maxTicks - 1), true)));
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return { niceMax, ticks };
};

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

// Emoji / pictograph / flag base code points.
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
// Zero-width joiner / emoji variation selector / combining keycap — kept
// out of the class above (as alternation) so `no-misleading-character-class`
// does not flag them as combining marks.
const EMOJI_MARKS = /\u200D|\uFE0F|\u20E3/gu;

/**
 * Drop emoji from a canvas label. The chart font (Noto Sans CJK) carries
 * no emoji glyphs, so an emoji in a channel / user name renders as a tofu
 * box; stripping keeps the readable text. Falls back to the original when
 * stripping would leave nothing (e.g. an all-emoji name) so a bar is
 * never unlabelled. Only canvas text passes through here — Discord-native
 * embed text keeps its emoji.
 */
export const stripEmoji = (text: string): string => {
  const cleaned = text
    .replace(EMOJI_PATTERN, '')
    .replace(EMOJI_MARKS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : text;
};

/** Trace a rounded rectangle path (caller fills / strokes). */
export const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void => {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
};

export const paintHeader = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  title: string,
): void => {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = FG;
  ctx.font = canvasFont(18, true);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(stripEmoji(title), 16, 30);
};

export const newCanvas = (
  height: number,
): { readonly canvas: Canvas; readonly ctx: CanvasRenderingContext2D } => {
  ensureCanvasFont();
  const canvas = createCanvas(WIDTH, height);
  return { canvas, ctx: canvas.getContext('2d') };
};

export const toAttachment = (canvas: Canvas, fileName: string): AttachmentBuilder =>
  new AttachmentBuilder(canvas.toBuffer('image/png'), { name: fileName });
