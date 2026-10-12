/**
 * View-model coverage for the `/traffic` subcommands: the dashboard renderers
 * are wrapped so each test can read the model a subcommand built, or make the
 * renderer throw.
 *
 * Pinned contracts: emoji honour `kind`, `source` and `order` and list unused
 * emoji separately (zero items included); stickers rank by `order` with unused
 * ones listed; apps rows split commands, components and modals; no model
 * carries a deleted count; a renderer failure ends in the translated `failed`
 * reply with a trace ID.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as dashboard from '../../../../src/handlers/commands/traffic-shared/dashboard';
import type {
  AppsDashboard,
  EmojiDashboard,
  StickerDashboard,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';
import Traffic from '../../../../src/handlers/commands/traffic';

import { fakeBot, fakeGuild, fakeInteraction, fakeStatsRepo } from './report-fixtures';

vi.mock('../../../../src/infra/graphics/image-loader', () => ({
  createImageLoader: () => ({ load: vi.fn(async () => null) }),
}));

vi.mock('../../../../src/handlers/commands/traffic-shared/dashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof dashboard>();
  const wrap = <F extends (...args: never[]) => Buffer>(render: F) => vi.fn(render);
  return {
    ...actual,
    renderOverviewDashboard: wrap(actual.renderOverviewDashboard),
    renderChannelDashboard: wrap(actual.renderChannelDashboard),
    renderPersonDashboard: wrap(actual.renderPersonDashboard),
    renderAppsDashboard: wrap(actual.renderAppsDashboard),
    renderAppSingleDashboard: wrap(actual.renderAppSingleDashboard),
    renderEmojiDashboard: wrap(actual.renderEmojiDashboard),
    renderStickerDashboard: wrap(actual.renderStickerDashboard),
  };
});

afterEach(() => vi.clearAllMocks());

type Values = Readonly<Record<string, string | number | boolean>>;

const run = async (
  subcommand: string,
  values: Values = {},
  t?: (key: string, params?: Record<string, unknown>) => string,
) => {
  const { interaction, replies } = fakeInteraction({ subcommand, values, guild: fakeGuild() });
  await new Traffic().execute(interaction, fakeBot(fakeStatsRepo(), t));
  return replies;
};

const modelOf = <T>(render: unknown): T => {
  const calls = (render as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]?.[0] as T;
};

const emojiModel = async (values: Values = {}): Promise<EmojiDashboard> => {
  await run('emoji', values);
  return modelOf<EmojiDashboard>(dashboard.renderEmojiDashboard);
};

const totalOf = (row: EmojiDashboard['ranking']['rows'][number]): number =>
  row.inContent + row.inReactions;

describe('/traffic emoji model', () => {
  it('ranks the most used first and lists unused emoji separately', async () => {
    const model = await emojiModel();
    const totals = model.ranking.rows.map(totalOf);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(totals.every((total) => total > 0)).toBe(true);
    // Every fourth fake emoji has no use at all.
    expect(model.unused?.names).toHaveLength(6);
    expect(model.unused?.names.every((name) => /^:.+:$/.test(name))).toBe(true);
  });

  it('ranks the least used first with order: least', async () => {
    const totals = (await emojiModel({ order: 'least' })).ranking.rows.map(totalOf);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it('keeps only animated or static emoji with kind', async () => {
    const animated = await emojiModel({ kind: 'animated' });
    expect(animated.ranking.rows.every((row) => row.animated)).toBe(true);
    vi.clearAllMocks();
    const still = await emojiModel({ kind: 'static' });
    expect(still.ranking.rows.some((row) => row.animated)).toBe(false);
  });

  it('counts only text or only reactions with source', async () => {
    const text = await emojiModel({ source: 'message' });
    expect(text.ranking.rows.every((row) => row.inReactions === 0 && row.inContent > 0)).toBe(true);
    vi.clearAllMocks();
    const reactions = await emojiModel({ source: 'reaction' });
    expect(reactions.ranking.rows.every((row) => row.inContent === 0)).toBe(true);
  });

  it('caps the ranking at top_n', async () => {
    expect((await emojiModel({ top_n: 3 })).ranking.rows).toHaveLength(3);
  });
});

describe('/traffic sticker model', () => {
  it('ranks by order and lists unused stickers', async () => {
    await run('sticker');
    const most = modelOf<StickerDashboard>(dashboard.renderStickerDashboard);
    const counts = most.ranking.rows.map((row) => row.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(most.unused?.names).toHaveLength(3);
    expect(most.ranking.totalUses).toBe(counts.reduce((a, b) => a + b, 0));
    vi.clearAllMocks();
    await run('sticker', { order: 'least' });
    const least = modelOf<StickerDashboard>(dashboard.renderStickerDashboard);
    expect(least.ranking.rows[0]?.count).toBe(Math.min(...counts));
  });
});

describe('/traffic apps model', () => {
  it('splits each app into commands, components and modals', async () => {
    await run('apps');
    const model = modelOf<AppsDashboard>(dashboard.renderAppsDashboard);
    expect(model.ranking.rows.map((row) => [row.name, ...row.segments])).toEqual([
      ['Bot A', 1050, 154, 0],
      ['Bot B', 310, 0, 0],
      ['Bot C', 120, 48, 8],
    ]);
    expect(model.ranking.legend).toHaveLength(3);
    expect(model.trend.previous?.values.length).toBeGreaterThan(0);
  });
});

describe('every /traffic model', () => {
  it.each([
    ['overview', dashboard.renderOverviewDashboard],
    ['channel', dashboard.renderChannelDashboard],
    ['me', dashboard.renderPersonDashboard],
    ['apps', dashboard.renderAppsDashboard],
    ['emoji', dashboard.renderEmojiDashboard],
    ['sticker', dashboard.renderStickerDashboard],
  ] as const)('%s carries no deleted count', async (subcommand, render) => {
    await run(subcommand);
    expect(JSON.stringify(modelOf(render))).not.toMatch(/delet/i);
  });

  it('answers a renderer failure with the translated failed copy and a trace ID', async () => {
    vi.mocked(dashboard.renderOverviewDashboard).mockImplementationOnce(() => {
      throw new Error('Missing Canvas CJK font');
    });
    const t = (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`;
    const replies = await run('overview', {}, t);
    // The public placeholder is deleted and the failure answered privately.
    expect(replies[0]).toEqual({ deleted: true });
    replies.shift();
    expect(replies).toHaveLength(1);
    expect((replies[0] as { flags?: number }).flags).toBe(64);
    expect(replies[0]?.content).toMatch(/^replies:traffic\.failed \{"traceId":"[0-9a-z]{6}"\}$/);
    expect(replies[0]?.files).toBeUndefined();
  });
});
