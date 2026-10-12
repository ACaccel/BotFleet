/**
 * Pixel-level checks of the /traffic dashboards: preloaded images are
 * drawn at their slot size with the aspect ratio kept, missing or broken
 * images fall back to placeholders, and colour-coded marks (previous
 * period line, delta direction, animated tag) appear only when their data
 * does. Counts are of pixels matching a colour exactly in the decoded PNG.
 */
import { createCanvas, Image, loadImage, type ImageData } from 'canvas';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  RANK_ROW_LIMIT,
  formatCount,
  renderAppsDashboard,
  renderEmojiDashboard,
  renderOverviewDashboard,
  renderPersonDashboard,
  renderStickerDashboard,
  type Delta,
  type InlinePart,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';
import { textWidth } from '../../../../src/handlers/commands/traffic-shared/dashboard/text';
import { ROW_HEIGHT } from '../../../../src/handlers/commands/traffic-shared/dashboard/bars';
import { unusedBlocks } from '../../../../src/handlers/commands/traffic-shared/dashboard/chips';
import { renderColumns } from '../../../../src/handlers/commands/traffic-shared/dashboard/columns';
import {
  TITLE_HEIGHT,
  type Column,
  type Ctx,
  type Section,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/layout';
import { rankingList } from '../../../../src/handlers/commands/traffic-shared/dashboard/ranking-lists';
import {
  COLOR,
  COLUMN_GAP,
  PAD,
  SCALE,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/theme';
import { trendBlocks } from '../../../../src/handlers/commands/traffic-shared/dashboard/trend';
import { ensureCanvasFont } from '../../../../src/infra/graphics/canvas-font';
import * as fixtures from './dashboard-fixtures';

const MAGENTA = '#ff00ff';

const decode = async (png: Buffer): Promise<ImageData> => {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
};

const rgbOf = (hex: string): readonly [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const matches = (data: ImageData, i: number, [r, g, b]: readonly number[]): boolean =>
  data.data[i] === r && data.data[i + 1] === g && data.data[i + 2] === b;

const countColor = async (png: Buffer, hex: string): Promise<number> => {
  const data = await decode(png);
  const rgb = rgbOf(hex);
  let n = 0;
  for (let i = 0; i < data.data.length; i += 4) if (matches(data, i, rgb)) n++;
  return n;
};

/** Right-most x (device pixels) of `hex` inside the band, or -1 when absent. */
const rightmost = async (
  png: Buffer,
  hex: string,
  band: { x0: number; x1: number; y0: number; y1: number },
): Promise<number> => {
  const data = await decode(png);
  const rgb = rgbOf(hex);
  let max = -1;
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      if (matches(data, (y * data.width + x) * 4, rgb)) max = Math.max(max, x);
    }
  }
  return max;
};

/** Pixels of `hex` inside the band (device pixels). */
const countColorIn = async (
  png: Buffer,
  hex: string,
  band: { x0: number; x1: number; y0: number; y1: number },
): Promise<number> => {
  const data = await decode(png);
  const rgb = rgbOf(hex);
  let n = 0;
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      if (matches(data, (y * data.width + x) * 4, rgb)) n++;
    }
  }
  return n;
};

const brokenImage = (): Image => new Image();

/** A one-column canvas of `width` holding `sections`, so a block sits at a known spot. */
const single = (width: number, sections: (col: Column, measure: Ctx) => readonly Section[]) =>
  renderColumns([{ width, sections }]);

describe('preloaded images', () => {
  const emojiWith = (image: () => Image | null): Buffer => {
    const base = fixtures.emoji();
    const rows = base.ranking.rows.map((r) => ({ ...r, image: image() }));
    return renderEmojiDashboard({ ...base, ranking: { ...base.ranking, rows } });
  };

  it('draws every emoji image at its 30 px slot and placeholders otherwise', async () => {
    const side = 30 * SCALE;
    const drawn = await countColor(
      emojiWith(() => fixtures.solidImage(MAGENTA)),
      MAGENTA,
    );
    expect(drawn).toBeGreaterThanOrEqual(20 * (side - 2) ** 2);
    expect(drawn).toBeLessThanOrEqual(20 * side ** 2);
    const fallback = emojiWith(() => null);
    expect(await countColor(fallback, MAGENTA)).toBe(0);
    expect(emojiWith(brokenImage).equals(fallback)).toBe(true);
  });

  it('keeps the aspect ratio of a non-square image', async () => {
    const side = 30 * SCALE;
    const wide = await countColor(
      emojiWith(() => fixtures.solidImage(MAGENTA, 64, 32)),
      MAGENTA,
    );
    expect(wide).toBeGreaterThanOrEqual(20 * (side - 2) * (side / 2 - 2));
    expect(wide).toBeLessThanOrEqual(20 * side * (side / 2));
  });

  it('draws sticker art at its 70 px slot and placeholders otherwise', async () => {
    const stickerWith = (image: () => Image | null): Buffer => {
      const base = fixtures.sticker();
      const rows = base.ranking.rows.map((r) => ({ ...r, image: image() }));
      return renderStickerDashboard({ ...base, ranking: { ...base.ranking, rows } });
    };
    const side = 70 * SCALE;
    const drawn = await countColor(
      stickerWith(() => fixtures.solidImage(MAGENTA)),
      MAGENTA,
    );
    expect(drawn).toBeGreaterThanOrEqual(12 * (side - 2) ** 2);
    expect(drawn).toBeLessThanOrEqual(12 * side ** 2);
    const fallback = stickerWith(() => null);
    expect(await countColor(fallback, MAGENTA)).toBe(0);
    expect(stickerWith(brokenImage).equals(fallback)).toBe(true);
  });

  it('clips app icons to a circle and draws coloured initials otherwise', async () => {
    const appsWith = (icon: () => Image | null): Buffer => {
      const base = fixtures.apps();
      const rows = base.ranking.rows.map((r) => ({ ...r, icon: icon() }));
      return renderAppsDashboard({ ...base, ranking: { ...base.ranking, rows } });
    };
    const radius = 10 * SCALE;
    const drawn = await countColor(
      appsWith(() => fixtures.solidImage(MAGENTA)),
      MAGENTA,
    );
    const circle = Math.PI * radius ** 2;
    expect(drawn).toBeGreaterThanOrEqual(5 * circle * 0.9);
    expect(drawn).toBeLessThanOrEqual(5 * circle * 1.05);
    const fallback = appsWith(() => null);
    expect(await countColor(fallback, MAGENTA)).toBe(0);
    expect(appsWith(brokenImage).equals(fallback)).toBe(true);
  });
});

describe('inline emoji tokens', () => {
  const withSub = (sub: readonly InlinePart[]): Buffer => {
    const base = fixtures.person();
    const [first = [], second = []] = base.tileRows;
    const tiles = second.map((t, i) => (i === 0 ? { ...t, sub } : t));
    return renderPersonDashboard({ ...base, tileRows: [first, tiles] });
  };

  it('draws the token image or its fallback name', async () => {
    const byName = withSub(['top ', { image: null, fallback: ':joy:' }, ' 210']);
    const broken = withSub(['top ', { image: brokenImage(), fallback: ':joy:' }, ' 210']);
    expect(broken.equals(byName)).toBe(true);
    expect(withSub(['top ', { image: null, fallback: ':smile:' }, ' 210']).equals(byName)).toBe(
      false,
    );
    const image = withSub(['top ', { image: fixtures.solidImage(MAGENTA), fallback: ':joy:' }]);
    const box = Math.round(12 * 1.25) * SCALE;
    const drawn = await countColor(image, MAGENTA);
    expect(drawn).toBeGreaterThanOrEqual((box - 2) ** 2);
    expect(drawn).toBeLessThanOrEqual(box ** 2);
    expect(await countColor(byName, MAGENTA)).toBe(0);
  });

  it('drops a fallback made only of emoji and the extra space around it', () => {
    const tofu = withSub(['top ', { image: null, fallback: '😂' }, ' 210']);
    expect(tofu.equals(withSub(['top 210']))).toBe(true);
  });
});

describe('colour-coded marks', () => {
  it('draws the gray previous-period line and legend only with a previous series', async () => {
    const base = fixtures.overview();
    const { previous: _previous, ...noPrevious } = base.trend;
    const withPrevious = renderOverviewDashboard(base);
    expect(await countColor(withPrevious, COLOR.previous)).toBeGreaterThan(200);
    const without = renderOverviewDashboard({ ...base, trend: noPrevious });
    expect(await countColor(without, COLOR.previous)).toBe(0);
    // In a wide column the legend shares the title row.
    const trend = (t: typeof base.trend) =>
      single(560, (col, measure) => [trendBlocks(measure, t, col)]);
    const titleBand = (png: Buffer) => ({
      x0: 0,
      x1: png.readUInt32BE(16),
      y0: PAD * SCALE,
      y1: (PAD + TITLE_HEIGHT) * SCALE,
    });
    const legend = trend(base.trend);
    expect(await countColorIn(legend, COLOR.previous, titleBand(legend))).toBeGreaterThan(10);
    const none = trend(noPrevious);
    expect(await countColorIn(none, COLOR.previous, titleBand(none))).toBe(0);
  });

  it('colours the hero delta by direction and omits the triangle when flat', async () => {
    const render = (delta: Delta | undefined): Buffer => {
      const base = fixtures.overview();
      return renderOverviewDashboard({ ...base, hero: { ...base.hero, delta } });
    };
    const delta = (direction: Delta['direction']): Delta => ({ direction, text: '8%', sub: 'x' });
    const up = render(delta('up'));
    const down = render(delta('down'));
    const flat = render(delta('flat'));
    expect(await countColor(up, COLOR.up)).toBeGreaterThan(50);
    expect(await countColor(up, COLOR.down)).toBe(0);
    expect(await countColor(down, COLOR.down)).toBeGreaterThan(50);
    expect(await countColor(down, COLOR.up)).toBe(0);
    expect(await countColor(flat, COLOR.up)).toBe(0);
    expect(await countColor(flat, COLOR.down)).toBe(0);
    const none = render(undefined);
    expect(none.equals(flat)).toBe(false);
    expect(await countColor(none, COLOR.up)).toBe(0);
  });

  it('leaves the triangle slot empty for a flat delta', async () => {
    // With an empty hero value and delta text, the triangle is the only
    // mark in its slot: centred 6 px right of the delta start, on the value line.
    const render = (direction: Delta['direction'], color: string) => {
      const base = fixtures.overview();
      const delta = { direction, text: '', sub: '' };
      const png = renderOverviewDashboard({ ...base, hero: { ...base.hero, value: '', delta } });
      const x = PAD + 14 + 12;
      const y = PAD + 42;
      const band = {
        x0: x * SCALE,
        x1: (x + 12) * SCALE,
        y0: (y - 6) * SCALE,
        y1: (y + 6) * SCALE,
      };
      return countColorIn(png, color, band);
    };
    expect(await render('up', COLOR.up)).toBeGreaterThan(20);
    expect(await render('flat', COLOR.muted)).toBe(0);
  });
});

describe('unranked lists', () => {
  it('draws nothing in the rank-number column of an unranked list', async () => {
    // Empty names leave the rank numbers as the only marks at the list's left edge.
    const base = fixtures.channel();
    const render = (ranked: boolean): Buffer => {
      // Empty names and no tags leave the rank numbers as the only marks.
      const rows = base.breakdown.rows.map((r) => ({ name: '', value: r.value }));
      const column = { ...base.breakdown, rows, ranked };
      return single(268, (col) => [rankingList(column, col)]);
    };
    const listTop = PAD + TITLE_HEIGHT;
    const band = {
      x0: PAD * SCALE,
      x1: (PAD + 8) * SCALE,
      y0: listTop * SCALE,
      y1: (listTop + RANK_ROW_LIMIT * ROW_HEIGHT) * SCALE,
    };
    const area = (band.x1 - band.x0) * (band.y1 - band.y0);
    const inked = async (png: Buffer): Promise<number> =>
      area - (await countColorIn(png, COLOR.embedBg, band));
    const ranked = render(true);
    expect(await inked(ranked)).toBeGreaterThan(100);
    expect(await countColorIn(ranked, COLOR.muted, band)).toBeGreaterThan(0);
    expect(await inked(render(false))).toBe(0);
  });
});

describe('unused chips', () => {
  it('truncates a name wider than the column so the chip stays inside it', async () => {
    const unused = fixtures.emoji().unused;
    if (unused === undefined) throw new Error('fixture needs an unused section');
    const width = 256;
    const section = { ...unused, names: [`:${'very_long_unused_name_'.repeat(8)}:`] };
    const png = single(width, (col, measure) => [unusedBlocks(measure, section, col, 4)]);
    // The single chip row sits right under the section title.
    const band = {
      x0: 0,
      x1: png.readUInt32BE(16),
      y0: (PAD + TITLE_HEIGHT) * SCALE,
      y1: (PAD + TITLE_HEIGHT + 22) * SCALE,
    };
    const right = await rightmost(png, COLOR.tile, band);
    expect(right).toBeGreaterThan((PAD + width - 20) * SCALE);
    expect(right).toBeLessThan((PAD + width) * SCALE);
  });
});

describe('animated emoji tag', () => {
  beforeAll(() => ensureCanvasFont());

  /** Private emoji layout, mirrored: the ranking column follows the 200 px summary column. */
  const RANKING_X = PAD + 200 + 24;
  const RANKING_WIDTH = 480;

  const onlyRow = (animated: boolean): Buffer => {
    const base = fixtures.emoji();
    const [row] = fixtures.emojiRows(1);
    if (row === undefined) throw new Error('fixture needs a row');
    const long = { ...row, label: ':an_extremely_long_emoji_name_that_cannot_fit:', animated };
    return renderEmojiDashboard({
      tiles: [],
      ranking: { ...base.ranking, rows: [long], note: undefined },
    });
  };

  it('reserves room for the tag before the total, even with a truncated label', async () => {
    const [row] = fixtures.emojiRows(1);
    if (row === undefined) throw new Error('fixture needs a row');
    const ctx = createCanvas(1, 1).getContext('2d');
    const totalW = textWidth(ctx, formatCount(row.inContent + row.inReactions), 14);
    // The tag box is COLOR.base; the first row spans the 46 px under the title,
    // in the left half of the ranking column.
    const halfRight = RANKING_X + (RANKING_WIDTH - COLUMN_GAP) / 2;
    const band = { x0: 0, x1: halfRight * SCALE, y0: 0, y1: (PAD + 26 + 50) * SCALE };
    const tagRight = await rightmost(onlyRow(true), COLOR.base, band);
    expect(tagRight).toBeGreaterThan(0);
    expect(tagRight).toBeLessThanOrEqual((halfRight - totalW - 4) * SCALE);
    expect(await rightmost(onlyRow(false), COLOR.base, band)).toBe(-1);
  });
});
