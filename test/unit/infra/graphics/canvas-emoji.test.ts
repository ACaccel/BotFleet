/**
 * Colour emoji images: with the Conda emoji font installed, Unicode emoji
 * (including flag, ZWJ and variation-selector sequences) come back as
 * coloured square images at small chart sizes; text the font does not
 * cover, and a missing font, yield `null` so callers keep their fallback.
 */
import * as fs from 'node:fs';
import { createCanvas, type Image, type ImageData } from 'canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canvasEmojiAvailable,
  renderEmojiImage,
} from '../../../../src/infra/graphics/canvas-emoji';

const pixelsOf = (image: Image): ImageData => {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
};

/** Opaque-ish pixels whose channels spread far enough apart to read as a colour, not gray. */
const colourPixels = (data: ImageData): number => {
  let n = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    const [r = 0, g = 0, b = 0, a = 0] = data.data.subarray(i, i + 4);
    if (a > 128 && Math.max(r, g, b) - Math.min(r, g, b) > 60) n++;
  }
  return n;
};

const redPixels = (data: ImageData): number => {
  let n = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    const [r = 0, g = 0, b = 0, a = 0] = data.data.subarray(i, i + 4);
    if (a > 128 && r > 180 && g < 100 && b < 100) n++;
  }
  return n;
};

describe('renderEmojiImage', () => {
  it('reports the installed emoji font as available', () => {
    expect(canvasEmojiAvailable()).toBe(true);
  });

  it.each([
    ['thumbs up', '\u{1F44D}'],
    ['tears of joy', '\u{1F602}'],
    ['red heart with VS16', '❤️'],
    ['Taiwan flag', '\u{1F1F9}\u{1F1FC}'],
    ['skin-tone modifier', '\u{1F44D}\u{1F3FD}'],
  ])('draws %s in colour at chart sizes', (_label, emoji) => {
    for (const size of [16, 20, 28]) {
      const image = renderEmojiImage(emoji, size);
      expect(image).not.toBeNull();
      if (image === null) return;
      expect([image.width, image.height]).toEqual([size, size]);
      // At least a fifth of the square is saturated colour, not a gray mask.
      expect(colourPixels(pixelsOf(image))).toBeGreaterThan((size * size) / 5);
    }
  });

  // Whether a ZWJ sequence shapes into one colour glyph depends on the host's
  // text stack, so it must come back either in colour or as null, never gray.
  it('draws a ZWJ sequence in colour or returns null, never a gray image', () => {
    for (const size of [16, 20, 28]) {
      const image = renderEmojiImage('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', size);
      if (image === null) continue;
      expect(colourPixels(pixelsOf(image))).toBeGreaterThan((size * size) / 5);
    }
  });

  it('keeps the glyph colours rather than a fill colour', () => {
    const heart = renderEmojiImage('❤️', 28);
    const flag = renderEmojiImage('\u{1F1F9}\u{1F1FC}', 28);
    if (heart === null || flag === null) throw new Error('expected emoji images');
    expect(redPixels(pixelsOf(heart))).toBeGreaterThan(150);
    expect(redPixels(pixelsOf(flag))).toBeGreaterThan(150);
  });

  it('returns the cached image for a repeated emoji and size', () => {
    const first = renderEmojiImage('\u{1F44D}', 24);
    expect(first).not.toBeNull();
    expect(renderEmojiImage('\u{1F44D}', 24)).toBe(first);
    expect(renderEmojiImage('\u{1F44D}', 25)).not.toBe(first);
  });

  it.each([
    ['empty text', ''],
    ['Latin text', 'A'],
    ['CJK text', '中'],
    ['a private-use code point', ''],
    ['two emoji', '\u{1F44D}\u{1F44D}'],
  ])('returns null for %s', (_label, text) => {
    expect(renderEmojiImage(text, 24)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, 513])('rejects size %s', (size) => {
    expect(() => renderEmojiImage('\u{1F44D}', size)).toThrow(RangeError);
  });
});

describe('renderEmojiImage without the emoji font', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('reports emoji unavailable and returns null, leaving the chart font usable', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...fs,
      existsSync: (path: fs.PathLike): boolean =>
        !String(path).endsWith('NotoColorEmoji.ttf') && fs.existsSync(path),
    }));
    const emoji = await import('../../../../src/infra/graphics/canvas-emoji');
    const font = await import('../../../../src/infra/graphics/canvas-font');

    expect(emoji.canvasEmojiAvailable()).toBe(false);
    expect(emoji.renderEmojiImage('\u{1F44D}', 24)).toBeNull();
    expect(() => font.ensureCanvasFont()).not.toThrow();
  });
});
