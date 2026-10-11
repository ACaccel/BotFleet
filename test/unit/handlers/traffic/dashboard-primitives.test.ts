/**
 * Pure helpers behind the /traffic dashboards: tick scaling, extreme
 * detection for trend annotations, number formatting, emoji templates,
 * width-aware ellipsis truncation, and inline runs of text plus emoji.
 */
import { createCanvas } from 'canvas';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  isEmojiOnly,
  stripEmoji,
} from '../../../../src/handlers/commands/traffic-shared/canvas-primitives';
import {
  EMOJI_SLOT,
  formatCount,
  formatPercent,
  richFromTemplate,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';
import {
  dashboardTicks,
  extremes,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/scale';
import {
  drawRich,
  fitText,
  richWidth,
  textWidth,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/text';
import { ensureCanvasFont } from '../../../../src/infra/graphics/canvas-font';
import { solidImage } from './dashboard-fixtures';

describe('dashboardTicks', () => {
  it('falls back to a 0..1 axis for empty or non-positive data', () => {
    expect(dashboardTicks(0)).toEqual({ niceMax: 1, ticks: [0, 1] });
    expect(dashboardTicks(-4)).toEqual({ niceMax: 1, ticks: [0, 1] });
    expect(dashboardTicks(Number.NaN)).toEqual({ niceMax: 1, ticks: [0, 1] });
  });

  it('uses at most three integer intervals covering the maximum', () => {
    expect(dashboardTicks(61)).toEqual({ niceMax: 75, ticks: [0, 25, 50, 75] });
    expect(dashboardTicks(2108)).toEqual({ niceMax: 3000, ticks: [0, 1000, 2000, 3000] });
  });

  it.each([1, 3, 7, 10, 24, 99, 101, 2500, 12345, 987654])(
    'ends at niceMax with constant integer spacing for max %d',
    (max) => {
      const { niceMax, ticks } = dashboardTicks(max);
      expect(niceMax).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(niceMax);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
      const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
      expect(ticks.every((t, i) => t === i * step)).toBe(true);
    },
  );
});

describe('extremes', () => {
  it('finds the peak and the quietest non-zero bucket', () => {
    expect(extremes([0, 5, 2, 9, 0, 2])).toEqual({ hi: 3, lo: 2 });
  });

  it('reports -1 when every bucket is zero', () => {
    expect(extremes([0, 0])).toEqual({ hi: -1, lo: -1 });
    expect(extremes([])).toEqual({ hi: -1, lo: -1 });
  });
});

describe('number formatting', () => {
  it('groups digits and rounds counts', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(2.6)).toBe('3');
  });

  it('formats a share and guards a zero denominator', () => {
    expect(formatPercent(1, 0, 1)).toBe('0.0%');
    expect(formatPercent(92, 410)).toBe('22%');
  });
});

describe('richFromTemplate', () => {
  const joy = { image: null, fallback: ':joy:' };
  const cat = { image: null, fallback: ':cat:' };

  it('fills each slot of one translated sentence with its token, in order', () => {
    const text = `Got ${EMOJI_SLOT} 210 times, then ${EMOJI_SLOT}`;
    expect(richFromTemplate(text, [joy, cat])).toEqual(['Got ', joy, ' 210 times, then ', cat]);
    expect(richFromTemplate(`${EMOJI_SLOT} first`, [joy])).toEqual([joy, ' first']);
  });

  it('drops slots without a token and ignores extra tokens', () => {
    expect(richFromTemplate(`a ${EMOJI_SLOT} b ${EMOJI_SLOT}`, [joy])).toEqual(['a ', joy, ' b ']);
    expect(richFromTemplate('no slot here', [joy])).toEqual(['no slot here']);
  });
});

describe('emoji detection', () => {
  it('flags text with nothing readable once emoji are removed', () => {
    expect(isEmojiOnly('😂')).toBe(true);
    expect(isEmojiOnly('👍🏽')).toBe(true);
    expect(isEmojiOnly(':joy:')).toBe(false);
    expect(isEmojiOnly('ok 👍')).toBe(false);
    expect(isEmojiOnly('')).toBe(false);
  });

  it.each([
    ['an emoji-presentation star', '\u2B50'],
    ['an emoji-presentation watch', '\u231A'],
    ['an arrow with an emoji variation selector', '\u21A9\uFE0F'],
    ['a keycap sequence', '1\uFE0F\u20E3'],
    ['a regional-indicator flag', '\u{1F1F9}\u{1F1FC}'],
    [
      'a tag-sequence flag (England)',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    ],
    ['a ZWJ family sequence', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['a text-default pictograph outside the BMP', '\u{1F549}'],
  ])('treats %s as emoji', (_, emoji) => {
    expect(isEmojiOnly(emoji)).toBe(true);
    expect(stripEmoji(`ok ${emoji} go`)).toBe('ok go');
  });

  it.each([
    ['a text-default arrow', '\u21A9'],
    ['a pointing hand the CJK font lacks', '\u261D'],
    ['a victory hand', '\u270C'],
    ['the copyright sign', '\u00A9'],
  ])('strips %s, which the emoji font could otherwise draw as a blank mask', (_, symbol) => {
    expect(stripEmoji(`${symbol} back`)).toBe('back');
    expect(isEmojiOnly(symbol)).toBe(true);
  });

  it('keeps arrows and stars that are not pictographs', () => {
    expect(stripEmoji('\u2192 \u2606 ok')).toBe('\u2192 \u2606 ok');
  });
});

describe('text measurement', () => {
  const ctx = createCanvas(1, 1).getContext('2d');
  beforeAll(() => ensureCanvasFont());

  it('keeps text that fits unchanged', () => {
    expect(fitText(ctx, 'general', 200, 13)).toBe('general');
  });

  it('truncates long text with an ellipsis inside the width', () => {
    const fitted = fitText(ctx, '非常非常非常長的頻道名稱-with-latin-tail', 80, 13);
    expect(fitted.endsWith('…')).toBe(true);
    expect(textWidth(ctx, fitted, 13)).toBeLessThanOrEqual(80);
    expect(fitted.startsWith('非常')).toBe(true);
  });

  it('collapses to a bare ellipsis when nothing fits', () => {
    expect(fitText(ctx, 'abcdef', 1, 13)).toBe('…');
  });

  it('keeps the spaces around inline emoji tokens', () => {
    const token = { image: null, fallback: ':joy:' };
    const spaced = richWidth(ctx, ['top ', token, ' 210'], 12);
    const glued = richWidth(ctx, ['top', token, '210'], 12);
    expect(spaced).toBeGreaterThan(glued);
  });

  it('gives an emoji-only fallback no width', () => {
    expect(richWidth(ctx, [{ image: null, fallback: '😂' }], 12)).toBe(0);
  });

  it('collapses the spaces around a slot that draws nothing into one', () => {
    const empty = { image: null, fallback: '😂' };
    const sentence = richFromTemplate(`top ${EMOJI_SLOT} 210`, [empty]);
    expect(richWidth(ctx, sentence, 12)).toBe(textWidth(ctx, 'top 210', 12));
  });

  it('never measures or draws a leftover emoji slot', () => {
    expect(textWidth(ctx, `top ${EMOJI_SLOT} 210`, 12)).toBe(textWidth(ctx, 'top 210', 12));
    expect(fitText(ctx, `a${EMOJI_SLOT}b`, 200, 12)).toBe('ab');
  });
});

describe('drawRich', () => {
  beforeAll(() => ensureCanvasFont());

  const WIDTH = 400;
  const HEIGHT = 40;
  const X = 10;
  const MAX = 100;

  /** Ink columns of a white run drawn on black, plus magenta (image) pixel count. */
  const draw = (parts: Parameters<typeof drawRich>[1], maxWidth?: number) => {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawRich(ctx, parts, X, HEIGHT / 2, { size: 13, color: '#ffffff' }, maxWidth);
    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    let right = -1;
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r = 0, g = 0, b = 0] = [data[i], data[i + 1], data[i + 2]];
      if (r + g + b > 0) right = Math.max(right, (i / 4) % WIDTH);
      if (r === 255 && g === 0 && b === 255) magenta++;
    }
    return { right, magenta };
  };

  const LONG = 'a very long line of text that will certainly not fit';

  it('truncates text at maxWidth', () => {
    expect(draw([LONG]).right).toBeGreaterThan(X + MAX + 20);
    expect(draw([LONG], MAX).right).toBeLessThanOrEqual(X + MAX);
  });

  it('skips an image token that no longer fits', () => {
    const token = { image: solidImage('#ff00ff'), fallback: ':joy:' };
    const textW = textWidth(createCanvas(1, 1).getContext('2d'), 'ok ', 13);
    expect(draw(['ok ', token], MAX).magenta).toBeGreaterThan(0);
    expect(draw(['ok ', token], textW + 4).magenta).toBe(0);
    expect(draw([LONG, token], MAX).magenta).toBe(0);
  });

  it('draws an emptied slot sentence as wide as the sentence without it', () => {
    const empty = { image: null, fallback: '😂' };
    const sentence = richFromTemplate(`top ${EMOJI_SLOT} 210`, [empty]);
    // A second space would push the last glyph about 3 px to the right.
    expect(draw(sentence).right).toBe(draw(['top 210']).right);
  });
});
