/**
 * Layout of the /traffic dashboard renderers: every dashboard renders at
 * the fixed width and a content-driven height that grows and shrinks by
 * exactly the section it gains or loses; ranked lists cap at their limit;
 * optional and empty sections collapse; long text truncates inside its
 * column; and malformed heatmaps are rejected.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DASHBOARD_WIDTH_PX,
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
import { TITLE_HEIGHT } from '../../../../src/handlers/commands/traffic-shared/dashboard/layout';
import { SCALE } from '../../../../src/handlers/commands/traffic-shared/dashboard/theme';
import * as fixtures from './dashboard-fixtures';

/** Private layout constants, mirrored in logical pixels. */
const SECTION_GAP = 22; // layout.ts
const TILE_GAP = 8; // tiles.ts
const TILE_HEIGHT = 70; // tiles.ts
const HEATMAP_GRID_HEIGHT = 7 * 15 + 20 + 24; // heatmap.ts GRID_HEIGHT
const EMOJI_ROW_HEIGHT = 46; // emoji.ts
const STICKER_GRID_HEIGHT = 3 * (138 + 8) - 8; // sticker.ts, three full card rows
const CHIP_HEIGHT = 22; // chips.ts
const CHIP_ROW_STEP = 28; // chips.ts

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const size = (png: Buffer): { width: number; height: number } => {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};
const heightOf = (png: Buffer): number => size(png).height;
const px = (logical: number): number => logical * SCALE;

describe('dashboard renderers', () => {
  /** Expected logical heights of the fixtures, from the layout constants. */
  const cases: readonly [string, () => Buffer, number][] = [
    ['overview', () => renderOverviewDashboard(fixtures.overview()), 1011],
    ['channel', () => renderChannelDashboard(fixtures.channel()), 1011],
    ['person', () => renderPersonDashboard(fixtures.person()), 1107],
    ['apps', () => renderAppsDashboard(fixtures.apps()), 744],
    ['apps single', () => renderAppSingleDashboard(fixtures.appSingle()), 779],
    ['emoji', () => renderEmojiDashboard(fixtures.emoji()), 732],
    ['sticker', () => renderStickerDashboard(fixtures.sticker()), 648],
  ];

  it.each(cases)('renders %s at the fixed width and its content height', (_, render, logical) => {
    const { width, height } = size(render());
    expect(width).toBe(DASHBOARD_WIDTH_PX);
    expect(Math.abs(height - px(logical))).toBeLessThanOrEqual(px(logical) * 0.05);
  });

  it('omits the heatmap section when it is not provided (24h range)', () => {
    const { heatmap: _omitted, ...withoutHeatmap } = fixtures.overview();
    const full = heightOf(renderOverviewDashboard(fixtures.overview()));
    const short = heightOf(renderOverviewDashboard(withoutHeatmap));
    expect(full - short).toBe(px(SECTION_GAP + TITLE_HEIGHT + HEATMAP_GRID_HEIGHT));
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

  it('keeps paired ranking columns at the height of the longer one', () => {
    const base = fixtures.overview();
    const shortLeft = { ...base, members: { ...base.members, rows: fixtures.rankRows('m', 3) } };
    const bothShort = {
      ...shortLeft,
      channels: { ...base.channels, rows: fixtures.rankRows('c', 3) },
    };
    const full = heightOf(renderOverviewDashboard(base));
    expect(heightOf(renderOverviewDashboard(shortLeft))).toBe(full);
    expect(full - heightOf(renderOverviewDashboard(bothShort))).toBe(
      px((RANK_ROW_LIMIT - 3) * ROW_HEIGHT),
    );
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
      const row = (base.tileRows[0] ?? []).map((t, i) => ({ ...t, flex: flex[i] }));
      return renderOverviewDashboard({ ...base, tileRows: [row] });
    };
    const plain = withFlex([undefined, undefined, undefined, undefined]);
    expect(withFlex([Number.NaN, Number.POSITIVE_INFINITY, 1, 1]).equals(plain)).toBe(true);
    expect(withFlex([-3, 0, 1, 1]).equals(withFlex([0.25, 0.25, 1, 1]))).toBe(true);
    expect(withFlex([0.25, 0.25, 1, 1]).equals(plain)).toBe(false);
  });
});

describe('empty and optional sections', () => {
  const overviewHeight = (patch: Partial<ReturnType<typeof fixtures.overview>> = {}): number =>
    heightOf(renderOverviewDashboard({ ...fixtures.overview(), ...patch }));
  const trendOf = (patch: Partial<TrendSection>): TrendSection => ({
    ...fixtures.trend(7),
    ...patch,
  });

  it('keeps the trend chart height for empty, single-point, and previous-less series', () => {
    const full = overviewHeight();
    const empty = trendOf({ current: [], previous: undefined, xLabels: [] });
    const single = trendOf({ current: [42], previous: undefined, xLabels: ['D1'] });
    const { previous: _previous, ...noPrevious } = trendOf({});
    expect(overviewHeight({ trend: empty })).toBe(full);
    expect(overviewHeight({ trend: single })).toBe(full);
    expect(overviewHeight({ trend: noPrevious })).toBe(full);
    const emptyPng = renderOverviewDashboard({ ...fixtures.overview(), trend: empty });
    const singlePng = renderOverviewDashboard({ ...fixtures.overview(), trend: single });
    expect(singlePng.equals(emptyPng)).toBe(false);
  });

  it('shrinks paired rankings to a single row when both are empty', () => {
    const base = fixtures.overview();
    const empty = {
      members: { ...base.members, rows: [] },
      channels: { ...base.channels, rows: [] },
    };
    expect(overviewHeight() - overviewHeight(empty)).toBe(px((RANK_ROW_LIMIT - 1) * ROW_HEIGHT));
  });

  it('sizes the detail pair by its longer column when content rows are empty', () => {
    const base = fixtures.overview();
    // Six content rows beside five interaction rows; dropping content leaves five.
    expect(overviewHeight() - overviewHeight({ content: { ...base.content, rows: [] } })).toBe(
      px(ROW_HEIGHT),
    );
  });

  it('keeps the heatmap height for an all-zero grid', () => {
    expect(overviewHeight({ heatmap: fixtures.heatmap(fixtures.fakeGrid(0)) })).toBe(
      overviewHeight(),
    );
  });

  it('drops empty tile rows under the hero', () => {
    const full = overviewHeight();
    expect(full - overviewHeight({ tileRows: [] })).toBe(px(TILE_GAP + TILE_HEIGHT));
    expect(overviewHeight({ tileRows: [[]] })).toBe(overviewHeight({ tileRows: [] }));
  });

  it('collapses an empty emoji ranking to one row and drops empty tiles', () => {
    const base = fixtures.emoji();
    const full = heightOf(renderEmojiDashboard(base));
    const noRows = { ...base, ranking: { ...base.ranking, rows: [] } };
    expect(full - heightOf(renderEmojiDashboard(noRows))).toBe(
      px((RANK_ROW_LIMIT - 1) * EMOJI_ROW_HEIGHT),
    );
    expect(full - heightOf(renderEmojiDashboard({ ...base, tiles: [] }))).toBe(
      px(TILE_HEIGHT + SECTION_GAP),
    );
  });

  it('collapses an empty sticker grid and drops empty tiles', () => {
    const base = fixtures.sticker();
    const full = heightOf(renderStickerDashboard(base));
    const noRows = { ...base, ranking: { ...base.ranking, rows: [] } };
    expect(full - heightOf(renderStickerDashboard(noRows))).toBe(px(STICKER_GRID_HEIGHT));
    expect(full - heightOf(renderStickerDashboard({ ...base, tiles: [] }))).toBe(
      px(TILE_HEIGHT + SECTION_GAP),
    );
  });

  it('draws only the unused title when no names are given, and wraps chips by rows', () => {
    const base = fixtures.emoji();
    const unused = base.unused;
    if (unused === undefined) throw new Error('fixture needs an unused section');
    const withNames = (names: readonly string[]): number =>
      heightOf(renderEmojiDashboard({ ...base, unused: { ...unused, names } }));
    const none = heightOf(renderEmojiDashboard({ ...base, unused: undefined }));
    expect(withNames([]) - none).toBe(px(SECTION_GAP + TITLE_HEIGHT));
    const oneRow = withNames([':a:', ':b:']);
    expect(oneRow - none).toBe(px(SECTION_GAP + TITLE_HEIGHT + CHIP_HEIGHT));
    const wrapped = withNames(Array.from({ length: 40 }, (_, i) => `:unused_${i}:`));
    expect(wrapped).toBeGreaterThan(oneRow);
    expect((wrapped - oneRow) % px(CHIP_ROW_STEP)).toBe(0);
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
      'person partner name (narrow left column)',
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
      ':a_long_emoji_label_x:',
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
      'ranking column title (narrow left column)',
      (text) => {
        const base = fixtures.overview();
        return renderOverviewDashboard({ ...base, members: { ...base.members, title: text } });
      },
      'a-long-ranking-column-title-xyz',
    ],
    [
      'full-width section title',
      (text) => {
        const base = fixtures.sticker();
        return renderStickerDashboard({ ...base, ranking: { ...base.ranking, title: text } });
      },
      'a-section-title-long-enough-to-overflow-the-full-inner-width-of-a-dashboard',
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
      'uses, a long caption',
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
