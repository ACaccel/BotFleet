/**
 * Layout of the /traffic dashboard renderers: every dashboard renders as
 * landscape columns at a fixed width and about 16:9, taller only when a
 * column's content needs it; ranked lists cap at their limit; the 24h
 * layout (no heatmap) keeps the canvas size; optional and empty sections
 * collapse without failing; long text truncates inside its column; and
 * malformed heatmaps are rejected.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  EMOJI_RANK_LIMIT,
  RANK_ROW_LIMIT,
  STICKER_RANK_LIMIT,
  renderAppSingleDashboard,
  renderAppsDashboard,
  renderChannelDashboard,
  renderEmojiDashboard,
  renderOverviewDashboard,
  renderPersonDashboard,
  renderStickerDashboard,
  type StatTile,
  type TrendSection,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';
import { ROW_HEIGHT } from '../../../../src/handlers/commands/traffic-shared/dashboard/bars';
import { canvasWidth } from '../../../../src/handlers/commands/traffic-shared/dashboard/columns';
import { SCALE } from '../../../../src/handlers/commands/traffic-shared/dashboard/theme';
import * as fixtures from './dashboard-fixtures';

/** Private column widths, mirrored in logical pixels. */
const WIDTHS = {
  overview: [256, 336, 268], // activity.ts SERVER_LAYOUT
  person: [300, 330, 268], // activity.ts PERSON_LAYOUT
  apps: [420, 440], // apps.ts
  appSingle: [420, 420], // apps.ts
  emoji: [256, 620], // emoji.ts
  sticker: [310, 4 * 130 + 3 * 8], // sticker.ts
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const size = (png: Buffer): { width: number; height: number } => {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};
const heightOf = (png: Buffer): number => size(png).height;
const px = (logical: number): number => logical * SCALE;
const withoutHeatmap = <T extends { heatmap?: unknown }>(data: T): Omit<T, 'heatmap'> => {
  const { heatmap: _omitted, ...rest } = data;
  return rest;
};

describe('dashboard renderers', () => {
  const cases: readonly [string, () => Buffer, readonly number[]][] = [
    ['overview', () => renderOverviewDashboard(fixtures.overview()), WIDTHS.overview],
    ['channel', () => renderChannelDashboard(fixtures.channel()), WIDTHS.overview],
    ['person', () => renderPersonDashboard(fixtures.person()), WIDTHS.person],
    ['apps', () => renderAppsDashboard(fixtures.apps()), WIDTHS.apps],
    ['apps single', () => renderAppSingleDashboard(fixtures.appSingle()), WIDTHS.appSingle],
    ['emoji', () => renderEmojiDashboard(fixtures.emoji()), WIDTHS.emoji],
    ['sticker', () => renderStickerDashboard(fixtures.sticker()), WIDTHS.sticker],
  ];

  it.each(cases)('renders %s as a landscape image of about 16:9', (_, render, widths) => {
    const { width, height } = size(render());
    expect(width).toBe(px(canvasWidth(widths)));
    const ratio = width / height;
    expect(ratio).toBeLessThanOrEqual(16 / 9 + 0.01);
    expect(ratio).toBeGreaterThan(1.6);
  });

  it.each([
    ['overview', () => renderOverviewDashboard(withoutHeatmap(fixtures.overview()))],
    ['channel', () => renderChannelDashboard(withoutHeatmap(fixtures.channel()))],
    ['person', () => renderPersonDashboard(withoutHeatmap(fixtures.person()))],
    ['apps single', () => renderAppSingleDashboard(withoutHeatmap(fixtures.appSingle()))],
  ] as const)('keeps the %s canvas size when the heatmap is omitted (24h)', (name, render) => {
    const full = cases.find(([n]) => n === name)?.[1];
    if (full === undefined) throw new Error(`no case ${name}`);
    const short = render();
    expect(size(short)).toEqual(size(full()));
    expect(short.equals(full())).toBe(false);
  });

  it('grows past 16:9 by exactly the rows a column gains once it is the tallest', () => {
    const withContent = (n: number): number => {
      const base = fixtures.overview();
      const rows = Array.from({ length: n }, (_, i) => ({ label: `c${i}`, value: 100 - i }));
      return heightOf(renderOverviewDashboard({ ...base, content: { ...base.content, rows } }));
    };
    const floor = withContent(6);
    expect(withContent(7)).toBe(floor);
    // Ten content rows make the middle column taller than the 16:9 floor.
    const tall = withContent(10);
    expect(tall).toBeGreaterThan(floor);
    expect(withContent(11) - tall).toBe(px(ROW_HEIGHT));
  });

  const capCases: readonly [string, (n: number) => Buffer, number][] = [
    [
      'overview members',
      (n) => {
        const base = fixtures.overview();
        const rows = fixtures.rankRows('m', n);
        return renderOverviewDashboard({ ...base, members: { ...base.members, rows } });
      },
      RANK_ROW_LIMIT,
    ],
    [
      'paired 24h rankings',
      (n) => {
        const base = withoutHeatmap(fixtures.overview());
        const rows = fixtures.rankRows('c', n);
        return renderOverviewDashboard({ ...base, channels: { ...base.channels, rows } });
      },
      RANK_ROW_LIMIT,
    ],
    [
      'apps ranking',
      (n) => {
        const base = fixtures.apps();
        const rows = fixtures.appRows(n);
        return renderAppsDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      RANK_ROW_LIMIT,
    ],
    [
      'folded members ranking',
      (n) => {
        const base = fixtures.apps();
        const rows = fixtures.rankRows('m', n);
        return renderAppsDashboard({ ...base, members: { ...base.members, rows } });
      },
      RANK_ROW_LIMIT,
    ],
    [
      'emoji ranking',
      (n) => {
        const base = fixtures.emoji();
        const rows = fixtures.emojiRows(n);
        return renderEmojiDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      EMOJI_RANK_LIMIT,
    ],
    [
      'sticker grid',
      (n) => {
        const base = fixtures.sticker();
        const rows = fixtures.stickerRows(n);
        return renderStickerDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      STICKER_RANK_LIMIT,
    ],
  ];

  it.each(capCases)('caps the %s at its row limit', (_, render, limit) => {
    const atLimit = render(limit);
    expect(render(limit + 7).equals(atLimit)).toBe(true);
    expect(render(limit - 1).equals(atLimit)).toBe(false);
  });

  it('draws a ranking without rank numbers when it is not ranked', () => {
    const base = fixtures.channel();
    const unranked = { ...base, breakdown: { ...base.breakdown, ranked: false } };
    const ranked = renderChannelDashboard(base);
    const plain = renderChannelDashboard(unranked);
    expect(heightOf(plain)).toBe(heightOf(ranked));
    expect(plain.equals(ranked)).toBe(false);
  });

  it('draws a negative ranking count as an empty bar labelled 0', () => {
    const withLast = (value: number): Buffer => {
      const base = fixtures.overview();
      const rows = [...fixtures.rankRows('m', 9), { name: 'm10', value }];
      return renderOverviewDashboard({ ...base, members: { ...base.members, rows } });
    };
    expect(withLast(-40).equals(withLast(0))).toBe(true);
    expect(withLast(1).equals(withLast(0))).toBe(false);
  });

  it('rejects a heatmap grid that is not 7 x 24 or lacks seven weekday labels', () => {
    const bad = { ...fixtures.overview(), heatmap: fixtures.heatmap([[1, 2, 3]]) };
    expect(() => renderOverviewDashboard(bad)).toThrow(RangeError);
    const labels = { ...fixtures.heatmap(), weekdayLabels: ['一', '二', '三', '四', '五', '六'] };
    expect(() => renderOverviewDashboard({ ...fixtures.overview(), heatmap: labels })).toThrow(
      RangeError,
    );
  });

  it('captions the heatmap peak only when some cell is non-zero', () => {
    const render = (grid: number[][]) => {
      const section = { ...fixtures.heatmap(grid), peakLabel: vi.fn(() => 'peak') };
      const moreLabel = vi.fn((max: string) => max);
      renderOverviewDashboard({ ...fixtures.overview(), heatmap: { ...section, moreLabel } });
      return { peakLabel: section.peakLabel, moreLabel };
    };
    const zero = render(fixtures.fakeGrid(0));
    expect(zero.peakLabel).not.toHaveBeenCalled();
    expect(zero.moreLabel).toHaveBeenCalledWith('0');
    const busy = render(fixtures.fakeGrid());
    expect(busy.peakLabel).toHaveBeenCalledWith('週日', 23);
    expect(busy.moreLabel).toHaveBeenCalledWith('79');
  });

  it('clamps tile flex weights so a tile never collapses', () => {
    const withFlex = (flex: readonly (number | undefined)[]): Buffer => {
      const base = fixtures.overview();
      const [first = [], ...rest] = base.tileRows;
      const row = first.map((t, i) => ({ ...t, flex: flex[i] }));
      return renderOverviewDashboard({ ...base, tileRows: [row, ...rest] });
    };
    const plain = withFlex([undefined, undefined]);
    expect(withFlex([Number.NaN, Number.POSITIVE_INFINITY]).equals(plain)).toBe(true);
    expect(withFlex([-3, 1]).equals(withFlex([0.25, 1]))).toBe(true);
    expect(withFlex([0.25, 1]).equals(plain)).toBe(false);
  });
});

describe('empty and optional sections', () => {
  const trendOf = (patch: Partial<TrendSection>): TrendSection => ({
    ...fixtures.trend(7),
    ...patch,
  });

  it('renders empty, single-point, and previous-less trends at the same size', () => {
    const render = (trend: TrendSection): Buffer =>
      renderOverviewDashboard({ ...fixtures.overview(), trend });
    const full = size(render(trendOf({})));
    const empty = render(trendOf({ current: [], previous: undefined, xLabels: [] }));
    const single = render(trendOf({ current: [42], previous: undefined, xLabels: ['D1'] }));
    const { previous: _previous, ...noPrevious } = trendOf({});
    expect(size(empty)).toEqual(full);
    expect(size(single)).toEqual(full);
    expect(size(render(noPrevious))).toEqual(full);
    expect(single.equals(empty)).toBe(false);
  });

  it('renders empty rankings, content and tiles without changing the canvas size', () => {
    const base = fixtures.overview();
    const full = size(renderOverviewDashboard(base));
    const emptied = renderOverviewDashboard({
      ...base,
      tileRows: [[], []],
      content: { ...base.content, rows: [] },
      members: { ...base.members, rows: [] },
      channels: { ...base.channels, rows: [] },
    });
    expect(size(emptied)).toEqual(full);
    const pair = withoutHeatmap(base);
    const emptyPair = {
      ...pair,
      members: { ...base.members, rows: [] },
      channels: { ...base.channels, rows: [] },
    };
    expect(size(renderOverviewDashboard(emptyPair))).toEqual(full);
  });

  it('drops empty tile rows under the hero', () => {
    const base = fixtures.overview();
    expect(
      renderOverviewDashboard({ ...base, tileRows: [[], []] }).equals(
        renderOverviewDashboard({ ...base, tileRows: [] }),
      ),
    ).toBe(true);
  });

  it('renders emoji and sticker dashboards without rows, tiles, or unused chips', () => {
    const emoji = fixtures.emoji();
    const sticker = fixtures.sticker();
    const emojiSize = size(renderEmojiDashboard(emoji)).width;
    const stickerSize = size(renderStickerDashboard(sticker)).width;
    const bareEmoji = renderEmojiDashboard({
      tiles: [],
      ranking: { ...emoji.ranking, rows: [], note: undefined },
    });
    const bareSticker = renderStickerDashboard({
      tiles: [],
      ranking: { ...sticker.ranking, rows: [], note: undefined },
    });
    expect(size(bareEmoji).width).toBe(emojiSize);
    expect(size(bareSticker).width).toBe(stickerSize);
  });

  it('caps unused chips at their rows with a trailing ellipsis chip', () => {
    const base = fixtures.emoji();
    const unused = base.unused;
    if (unused === undefined) throw new Error('fixture needs an unused section');
    const render = (count: number): Buffer =>
      renderEmojiDashboard({
        ...base,
        unused: { ...unused, names: Array.from({ length: count }, (_, i) => `:unused_${i}:`) },
      });
    const many = render(80);
    expect(render(120).equals(many)).toBe(true);
    expect(heightOf(many)).toBe(heightOf(render(2)));
  });
});

describe('text truncation', () => {
  /** Placeholder art hashes the name, so name-only cases draw real art. */
  const art = fixtures.solidImage('#808080');
  const TAIL = '-tail';

  /** Overview whose last (right-most) stat tile is replaced, so an overflow lands on the background. */
  const lastTile = (patch: (text: string) => Partial<StatTile>) => (text: string) => {
    const base = fixtures.overview();
    const row = base.tileRows[0] ?? [];
    const tiles = row.map((t, i) => (i === row.length - 1 ? { ...t, ...patch(text) } : t));
    return renderOverviewDashboard({ ...base, tileRows: [tiles] });
  };

  /**
   * Each long text overflows its slot but, untruncated, would still end
   * inside the canvas, so a missing truncation changes the pixels.
   */
  const cases: readonly [string, (text: string) => Buffer, string][] = [
    [
      'person partner name (middle column)',
      (text) => {
        const base = fixtures.person();
        const rows = base.partners.rows.map((r, i) => (i === 0 ? { ...r, name: text } : r));
        return renderPersonDashboard({ ...base, partners: { ...base.partners, rows } });
      },
      'partner-name-that-is-long',
    ],
    [
      'hero metric label',
      (text) => {
        const base = fixtures.overview();
        const metrics = base.hero.metrics.map((m, i) => (i === 0 ? { ...m, label: text } : m));
        return renderOverviewDashboard({ ...base, hero: { ...base.hero, metrics } });
      },
      'a-long-metric-label',
    ],
    [
      'hero value',
      (text) => {
        const base = fixtures.overview();
        return renderOverviewDashboard({ ...base, hero: { ...base.hero, value: text } });
      },
      '1,234,567,890,123',
    ],
    [
      'hero metric value',
      (text) => {
        const base = fixtures.overview();
        const metrics = base.hero.metrics.map((m, i) => (i === 0 ? { ...m, value: text } : m));
        return renderOverviewDashboard({ ...base, hero: { ...base.hero, metrics } });
      },
      '12,345,678,901',
    ],
    [
      'sticker card name',
      (text) => {
        const base = fixtures.sticker();
        const rows = base.ranking.rows.map((r, i) =>
          i === 0 ? { ...r, name: text, image: art } : r,
        );
        return renderStickerDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      'a-long-sticker-card-name',
    ],
    [
      'animated emoji label',
      (text) => {
        const base = fixtures.emoji();
        const rows = base.ranking.rows.map((r, i) =>
          i === 0 ? { ...r, label: text, animated: true, image: art } : r,
        );
        return renderEmojiDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      ':a_long_emoji_label_for_the_wide_half_x:',
    ],
    [
      'heatmap weekday label',
      (text) => {
        const base = fixtures.overview();
        const section = fixtures.heatmap();
        const weekdayLabels = section.weekdayLabels.map((l, i) => (i === 0 ? text : l));
        return renderOverviewDashboard({ ...base, heatmap: { ...section, weekdayLabels } });
      },
      'Wednesday-long',
    ],
    [
      'heatmap peak caption on its own line',
      (text) => {
        const base = fixtures.overview();
        return renderOverviewDashboard({
          ...base,
          heatmap: { ...fixtures.heatmap(), peakLabel: () => text },
        });
      },
      'Peak caption long enough to overflow the column x',
    ],
    ['stat tile label', lastTile((label) => ({ label })), 'a-long-stat-tile-label'],
    ['stat tile value', lastTile((value) => ({ value })), '1,234,567,890'],
    ['stat tile unit', lastTile((unit) => ({ value: '1', unit })), 'a-long-unit-texts'],
    ['stat tile sub-line', lastTile((sub) => ({ sub })), 'a-long-stat-tile-sub-x'],
    [
      'hero metric unit',
      (text) => {
        const base = fixtures.overview();
        const metrics = base.hero.metrics.map((m, i) => (i === 2 ? { ...m, unit: text } : m));
        return renderOverviewDashboard({ ...base, hero: { ...base.hero, metrics } });
      },
      'a-long-unit',
    ],
    [
      'plain bar label',
      (text) => {
        const base = fixtures.overview();
        const rows = base.content.rows.map((r, i, all) =>
          i === all.length - 1 ? { ...r, label: text } : r,
        );
        return renderOverviewDashboard({ ...base, content: { ...base.content, rows } });
      },
      'a-long-bar-label-text',
    ],
    [
      'forum rank tag',
      (text) => {
        const base = fixtures.overview();
        // A low count keeps the bar short, so an overflowing tag is not hidden under it.
        const rows = [...fixtures.rankRows('c', 9), { name: 'post', tag: text, value: 10 }];
        return renderOverviewDashboard({ ...base, channels: { ...base.channels, rows } });
      },
      'a-long-forum-tag-x',
    ],
    [
      'ranking column title (middle column)',
      (text) => {
        const base = fixtures.overview();
        return renderOverviewDashboard({ ...base, members: { ...base.members, title: text } });
      },
      'a-long-ranking-column-title-that-overflows-the-middle-column',
    ],
    [
      'column-wide section title',
      (text) => {
        const base = fixtures.sticker();
        const unused = base.unused;
        if (unused === undefined) throw new Error('fixture needs an unused section');
        return renderStickerDashboard({ ...base, unused: { ...unused, title: text } });
      },
      'a-section-title-long-enough-to-overflow-the-summary-column-width',
    ],
    [
      'app users caption',
      (text) => {
        const base = fixtures.apps();
        const rows = base.ranking.rows.map((r, i) => (i === 0 ? { ...r, users: text } : r));
        return renderAppsDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      'users-caption-long',
    ],
    [
      'app name',
      (text) => {
        const base = fixtures.apps();
        const rows = base.ranking.rows.map((r, i) =>
          i === 0 ? { ...r, name: text, icon: art } : r,
        );
        return renderAppsDashboard({ ...base, ranking: { ...base.ranking, rows } });
      },
      'An application name that is long enough to need an ellipsis',
    ],
    [
      'sticker count caption',
      (text) => {
        const base = fixtures.sticker();
        return renderStickerDashboard({
          ...base,
          ranking: { ...base.ranking, countCaption: () => text },
        });
      },
      'uses, a long caption that overflows',
    ],
    [
      'key-value label beside a wide value',
      (text) => {
        const base = fixtures.overview();
        const rows = base.interactions.rows.map((r, i) =>
          i === 0 ? { ...r, label: text, value: '12,345,678' } : r,
        );
        return renderOverviewDashboard({ ...base, interactions: { ...base.interactions, rows } });
      },
      'a-long-key-value-label-text-xyz',
    ],
  ];

  it.each(cases)('truncates a long %s inside its slot', (_, render, long) => {
    expect(render(long).equals(render(`${long}${TAIL}`))).toBe(true);
    expect(render('Aa').equals(render('Bb'))).toBe(false);
  });
});
