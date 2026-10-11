/**
 * Text primitives for the dashboards: simulated bold, width-aware
 * ellipsis truncation, and inline runs of text plus emoji. The registered
 * CJK font is a variable font that only exposes its default weight, so
 * bold is a thin same-colour stroke. Text passes through `stripEmoji`
 * because the font has no emoji glyphs and Pango's fallback would draw
 * tofu boxes or monochrome outlines instead; an emoji token's fallback
 * that is nothing but emoji is dropped for the same reason.
 */
import type { Image } from 'canvas';

import { canvasFont } from '../../../../infra/graphics/canvas-font';
import { isEmojiOnly, stripEmoji } from '../canvas-primitives';
import type { Ctx } from './layout';
import { drawImageFit, isDrawable } from './image';
import { EMOJI_SLOT } from './rich';
import type { RichText } from './types-common';

export interface TextStyle {
  readonly size: number;
  readonly color: string;
  readonly bold?: boolean;
  readonly align?: 'left' | 'center' | 'right';
}

const ELLIPSIS = '…';

/**
 * `stripEmoji` also trims, which would glue inline runs together
 * (`'Top ' + emoji`), so the outer whitespace is kept. A stray
 * `EMOJI_SLOT` (a sentence that skipped `richFromTemplate`) is dropped
 * rather than drawn as a box.
 */
const visible = (text: string): string => {
  const raw = text.split(EMOJI_SLOT).join('');
  const lead = /^\s*/.exec(raw)?.[0] ?? '';
  const trail = raw.length > lead.length ? (/\s*$/.exec(raw)?.[0] ?? '') : '';
  return `${lead}${stripEmoji(raw)}${trail}`;
};

export const textWidth = (ctx: Ctx, text: string, size: number): number => {
  ctx.font = canvasFont(size);
  return ctx.measureText(visible(text)).width;
};

/** Draw one line of text vertically centred on `y`. */
export const drawText = (ctx: Ctx, text: string, x: number, y: number, style: TextStyle): void => {
  const value = visible(text);
  ctx.font = canvasFont(style.size);
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
  if (style.bold === true) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.size * 0.055;
    ctx.lineJoin = 'round';
    ctx.strokeText(value, x, y);
  }
};

/** `text` unchanged when it fits, else its longest prefix plus an ellipsis. */
export const fitText = (ctx: Ctx, text: string, maxWidth: number, size: number): string => {
  const value = visible(text);
  if (textWidth(ctx, value, size) <= maxWidth) return value;
  const chars = Array.from(value);
  const withEllipsis = (n: number): string => `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(ctx, withEllipsis(mid), size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return withEllipsis(lo);
};

/** Draw `text` truncated to `maxWidth`. */
export const drawFitted = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  style: TextStyle,
): void => drawText(ctx, fitText(ctx, text, maxWidth, style.size), x, y, style);

/** What a rich run actually draws: text runs and preloaded images. */
type Run = { readonly text: string } | { readonly image: Image };

const emojiBox = (size: number): number => Math.round(size * 1.25);

/**
 * Resolve tokens to an image or their fallback text, drop fallbacks made
 * only of emoji, and merge neighbouring text so the spaces around a token
 * that drew nothing collapse into one (`visible` folds inner whitespace).
 */
const runsOf = (text: RichText): Run[] => {
  const runs: Run[] = [];
  let pending = '';
  for (const part of typeof text === 'string' ? [text] : text) {
    if (typeof part !== 'string' && isDrawable(part.image)) {
      if (pending.length > 0) runs.push({ text: pending });
      pending = '';
      runs.push({ image: part.image });
    } else if (typeof part === 'string') {
      pending += part;
    } else if (!isEmojiOnly(part.fallback)) {
      pending += part.fallback;
    }
  }
  if (pending.length > 0) runs.push({ text: pending });
  return runs;
};

const runWidth = (ctx: Ctx, run: Run, size: number): number =>
  'image' in run ? emojiBox(size) : textWidth(ctx, run.text, size);

export const richWidth = (ctx: Ctx, text: RichText, size: number): number =>
  runsOf(text).reduce((sum, run) => sum + runWidth(ctx, run, size), 0);

/** Draw a left-aligned run of text and emoji, truncating at `maxWidth`. */
export const drawRich = (
  ctx: Ctx,
  text: RichText,
  x: number,
  y: number,
  style: TextStyle,
  maxWidth = Number.POSITIVE_INFINITY,
): void => {
  let cx = x;
  for (const run of runsOf(text)) {
    const remaining = x + maxWidth - cx;
    const width = runWidth(ctx, run, style.size);
    if ('image' in run) {
      if (width > remaining) return;
      const box = emojiBox(style.size);
      drawImageFit(ctx, run.image, cx, y - box / 2, box, box);
    } else if (width > remaining) {
      drawFitted(ctx, run.text, cx, y, remaining, { ...style, align: 'left' });
      return;
    } else {
      drawText(ctx, run.text, cx, y, { ...style, align: 'left' });
    }
    cx += width;
  }
};
