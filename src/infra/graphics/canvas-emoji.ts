/**
 * Colour Unicode emoji for Canvas images, drawn from Noto Color Emoji
 * (CBDT colour bitmaps, OFL-1.1) shipped in the Conda runtime.
 *
 * node-canvas draws text as paths by default, which flattens a bitmap
 * glyph into a one-colour mask, so emoji are drawn in `glyph` mode. The
 * font has a single 109 ppem strike (136 x 128 px bitmaps) and whether
 * fontconfig scales it depends on the host configuration, so each emoji is
 * drawn at that native size and then scaled with `drawImage`.
 *
 * The font is registered lazily, on the first call here, and a missing or
 * unusable font only disables emoji images: callers get `null` and keep
 * their text fallback. Once registered, fontconfig may also pick the font
 * as the fallback for pictographs the CJK chart font lacks (e.g. U+261D),
 * which path-mode `fillText` draws as near-empty masks, so a caller that
 * opts in should route every pictograph through `renderEmojiImage`.
 */
import { existsSync } from 'node:fs';
import {
  createCanvas,
  Image,
  registerFont,
  type Canvas,
  type CanvasRenderingContext2D,
} from 'canvas';

import { condaFontPath } from './canvas-font';

const EMOJI_FONT_FAMILY = 'BotFleet Emoji';
const EMOJI_FONT_FILE = 'NotoColorEmoji.ttf';
/** The font's only bitmap strike; drawing at this size needs no glyph scaling. */
const NATIVE_FONT_SIZE = 109;
const PROBE_EMOJI = '\u{1F602}';
/**
 * A sequence the font cannot join (a newer ZWJ emoji) falls apart into
 * several glyphs; anything wider than one cell plus this slack is rejected.
 */
const MAX_ADVANCE_RATIO = 1.25;
const MAX_IMAGE_SIZE = 512;
const CACHE_LIMIT = 512;
// Colour bitmap glyphs ignore the fill style; outline glyphs from any
// fallback font (or a missing-glyph box) take it. Drawing twice with
// different fills tells the two apart.
const PROBE_FILLS = ['#ff0000', '#0000ff'] as const;

/** Native-size cell shared by every emoji, so relative glyph sizes survive scaling. */
interface EmojiCell {
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

let cell: EmojiCell | null | undefined;
const cache = new Map<string, Image | null>();

const emojiContext = (canvas: Canvas): CanvasRenderingContext2D => {
  const ctx = canvas.getContext('2d');
  ctx.font = `${NATIVE_FONT_SIZE}px "${EMOJI_FONT_FAMILY}"`;
  ctx.textDrawingMode = 'glyph';
  ctx.textBaseline = 'alphabetic';
  return ctx;
};

/** Draw `text` at native size, or `null` when the colour font did not draw all of it. */
const drawNative = (text: string, geometry: EmojiCell): Canvas | null => {
  const measured = emojiContext(createCanvas(1, 1)).measureText(text);
  if (!(measured.width > 0) || measured.width > geometry.width * MAX_ADVANCE_RATIO) return null;

  const x = (geometry.width - measured.width) / 2;
  const canvases = PROBE_FILLS.map((fill) => {
    const canvas = createCanvas(geometry.width, geometry.height);
    const ctx = emojiContext(canvas);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, geometry.baseline);
    return { canvas, pixels: ctx.getImageData(0, 0, geometry.width, geometry.height).data };
  });
  const [first, second] = canvases;
  if (first === undefined || second === undefined) return null;
  let inked = false;
  for (let i = 0; i < first.pixels.length; i++) {
    if (first.pixels[i] !== second.pixels[i]) return null;
    if (i % 4 === 3 && first.pixels[i] !== 0) inked = true;
  }
  return inked ? first.canvas : null;
};

const loadEmojiFont = (): EmojiCell | null => {
  const fontPath = condaFontPath(EMOJI_FONT_FILE);
  if (!existsSync(fontPath)) return null;
  try {
    registerFont(fontPath, { family: EMOJI_FONT_FAMILY });
  } catch {
    return null;
  }
  const metrics = emojiContext(createCanvas(1, 1)).measureText(PROBE_EMOJI);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent);
  const geometry: EmojiCell = {
    width: Math.ceil(metrics.width),
    height: ascent + Math.ceil(metrics.actualBoundingBoxDescent),
    baseline: ascent,
  };
  if (!(geometry.width > 0 && geometry.height > 0)) return null;
  return drawNative(PROBE_EMOJI, geometry) === null ? null : geometry;
};

const emojiCell = (): EmojiCell | null => {
  if (cell === undefined) cell = loadEmojiFont();
  return cell;
};

/**
 * Whether colour emoji can be drawn: the emoji font is installed,
 * registered, and renders a known emoji in colour. Never throws.
 */
export const canvasEmojiAvailable = (): boolean => emojiCell() !== null;

const remember = (key: string, image: Image | null): Image | null => {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, image);
  return image;
};

/**
 * Draw one Unicode emoji (a single grapheme, including ZWJ, flag, keycap
 * and skin-tone sequences) as a transparent `size` x `size` image, centred
 * with its aspect ratio kept. Returns `null` when the emoji font is
 * unavailable or does not cover `text` (plain text, an emoji newer than
 * the font, several emoji), so the caller draws its fallback instead.
 * Results are cached per text and size.
 *
 * @throws RangeError when `size` is not an integer from 1 to 512.
 */
export const renderEmojiImage = (text: string, size: number): Image | null => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_IMAGE_SIZE) {
    throw new RangeError(
      `Emoji image size must be an integer from 1 to ${MAX_IMAGE_SIZE}: ${size}`,
    );
  }
  const geometry = emojiCell();
  if (geometry === null || text.length === 0) return null;

  const key = `${size}:${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const native = drawNative(text, geometry);
  if (native === null) return remember(key, null);

  const output = createCanvas(size, size);
  const ctx = output.getContext('2d');
  ctx.patternQuality = 'best';
  const ratio = Math.min(size / geometry.width, size / geometry.height);
  const width = geometry.width * ratio;
  const height = geometry.height * ratio;
  ctx.drawImage(native, (size - width) / 2, (size - height) / 2, width, height);

  const image = new Image();
  image.src = output.toBuffer('image/png');
  return remember(key, image);
};
