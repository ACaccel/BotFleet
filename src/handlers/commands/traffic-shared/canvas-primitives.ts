/**
 * Canvas helpers for the /traffic dashboard renderers. Kept free of
 * discord.js so the dashboards depend only on `canvas`.
 */
import type { CanvasRenderingContext2D } from 'canvas';

/**
 * Everything that renders as a colour emoji or needs the emoji font: keycap
 * sequences, every pictograph (with or without a variation selector),
 * emoji-presentation characters (`⭐`, `⌚`), skin-tone modifiers, flag
 * letters, and the tag characters of subdivision flags. Text-default BMP
 * pictographs (`©`, `↩`, `☝`) go too: once the colour emoji font is
 * registered, fontconfig may pick it for a pictograph the CJK font lacks,
 * and path-mode text draws its bitmap glyph as a near-empty mask. Emoji
 * that should show are passed as images (`renderEmojiImage`) instead.
 */
const EMOJI_PATTERN =
  /[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{E0020}-\u{E007F}]/gu;
// Leftover zero-width joiners, emoji variation selectors, and combining
// keycaps, kept out of any character class (as alternation) so
// `no-misleading-character-class` does not flag them as combining marks.
const EMOJI_MARKS = /\u200D|\uFE0F|\u20E3/gu;

const withoutEmoji = (text: string): string =>
  text.replace(EMOJI_PATTERN, '').replace(EMOJI_MARKS, '').replace(/\s+/g, ' ').trim();

/**
 * Drop emoji from a canvas label. The chart font (Noto Sans CJK) carries
 * no emoji glyphs, so an emoji in a channel / user name renders as a tofu
 * box; stripping keeps the readable text. Falls back to the original when
 * stripping would leave nothing (e.g. an all-emoji name) so a bar is
 * never unlabelled. Only canvas text passes through here — Discord-native
 * embed text keeps its emoji.
 */
export const stripEmoji = (text: string): string => {
  const cleaned = withoutEmoji(text);
  return cleaned.length > 0 ? cleaned : text;
};

/** True when `text` has emoji but nothing readable once they are removed. */
export const isEmojiOnly = (text: string): boolean =>
  text.trim().length > 0 && withoutEmoji(text).length === 0;

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
