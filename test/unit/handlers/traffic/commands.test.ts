/**
 * Handler coverage for every `/traffic` subcommand, run through the grouped
 * root with a fake statistics reader and the real dashboard renderers. CDN
 * downloads are stubbed to fail, so every reply also proves a missing picture
 * never fails the image.
 *
 * Pinned contracts: the reply is deferred (publicly by default) before any query,
 * and refusals, notices and errors reach only the invoker; the report is one embed with
 * the report title and the dashboard PNG, no summary line and no footer, and
 * only overview and channel put the top messages in the embed text; member
 * statistics only count the invoker's visible channels while emoji and stickers
 * count every channel; `/traffic channel` answers a hidden channel exactly like
 * a missing one, and the `public` ceiling applies; a query timeout asks for a
 * smaller range; apps read interaction records only; nothing shows a deleted
 * count.
 */
import { describe, expect, it, vi } from 'vitest';

import { DatabaseError } from '../../../../src/core/errors/external-service-error';
import { err } from '../../../../src/core/result';
import Traffic from '../../../../src/handlers/commands/traffic';
import TrafficOverview from '../../../../src/handlers/commands/traffic/action';
import TrafficApps from '../../../../src/handlers/commands/traffic_apps/action';
import TrafficChannel from '../../../../src/handlers/commands/traffic_channel/action';
import TrafficMe from '../../../../src/handlers/commands/traffic_me/action';
import TrafficUser from '../../../../src/handlers/commands/traffic_user/action';
import {
  APP_RANK_LIMIT,
  RANK_ROW_LIMIT,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';

import {
  fakeBot,
  fakeGuild,
  fakeInteraction,
  fakeStatsRepo,
  INVOKER_ID,
  type Reply,
} from './report-fixtures';

vi.mock('../../../../src/infra/graphics/image-loader', () => ({
  createImageLoader: () => ({ load: vi.fn(async () => null) }),
}));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

type InteractionOptions = Parameters<typeof fakeInteraction>[0];

const run = async (
  options: InteractionOptions,
  stats = fakeStatsRepo(),
  t?: (key: string, params?: Record<string, unknown>) => string,
) => {
  const order: string[] = [];
  const { interaction, replies, deferred } = fakeInteraction(options);
  const defer = interaction.deferReply.bind(interaction);
  interaction.deferReply = (async (payload: unknown) => {
    order.push('defer');
    return defer(payload as never);
  }) as typeof interaction.deferReply;
  const tracked = new Proxy(stats, {
    get: (target, key, receiver) => {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || key === 'calls') return value;
      return (...args: unknown[]) => {
        order.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  await new Traffic().execute(interaction, fakeBot(tracked, t));
  return { replies, deferred, order, stats };
};

const embedText = (reply: Reply | undefined): string =>
  JSON.stringify((reply?.embeds ?? []).map((embed) => embed.toJSON()));

interface EmbedShape {
  readonly title?: string;
  readonly description?: string;
  readonly footer?: unknown;
  readonly image?: { url: string };
}

const embedOf = (reply: Reply | undefined): EmbedShape | undefined =>
  reply?.embeds?.[0]?.toJSON() as EmbedShape | undefined;

const HOT_HEADING = 'replies:traffic.hot.heading';

/** A notice after a public deferral: the placeholder is deleted, the answer is ephemeral. */
const privately = (content: string): Reply[] => [{ deleted: true }, { content, flags: 64 }];

/**
 * An embed with title, image and no footer, whose text is the top messages when
 * `hot`; with `details` (activity dashboards), a second embed with only its image.
 */
const expectDashboard = (reply: Reply | undefined, hot: boolean, details: boolean): void => {
  expect(reply?.content).toBeUndefined();
  expect(reply?.embeds).toHaveLength(details ? 2 : 1);
  const embed = embedOf(reply);
  const file = reply?.files?.[0];
  expect(reply?.files).toHaveLength(details ? 2 : 1);
  if (details) {
    const second = reply?.embeds?.[1]?.toJSON() as EmbedShape | undefined;
    const detailsFile = reply?.files?.[1];
    expect(second?.image?.url).toBe(`attachment://${String(detailsFile?.name)}`);
    expect(detailsFile?.name).not.toBe(file?.name);
    expect(second?.title).toBeUndefined();
    expect(second?.description).toBeUndefined();
    expect((detailsFile?.attachment as Buffer).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
  }
  expect(embed?.image?.url).toBe(`attachment://${String(file?.name)}`);
  expect(embed?.title).toMatch(/^replies:traffic\.[a-z]+\.title$/);
  expect(embed?.footer).toBeUndefined();
  if (hot) {
    const [heading, ...lines] = (embed?.description ?? '').split('\n');
    expect(heading).toBe(HOT_HEADING);
    expect(lines.length).toBeGreaterThan(0);
  } else {
    expect(embed?.description).toBeUndefined();
  }
  expect((reply as { allowedMentions?: unknown } | undefined)?.allowedMentions).toEqual({
    parse: [],
  });
  expect((file?.attachment as Buffer).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
};

describe('/traffic subcommands', () => {
  it.each([
    ['overview', { subcommand: 'overview' }, true, true],
    ['channel', { subcommand: 'channel', channel: 'c1' }, true, true],
    [
      'channel without threads',
      { subcommand: 'channel', channel: 'c2', values: { range: '30d' } },
      true,
      true,
    ],
    ['me', { subcommand: 'me', values: { range: '24h' } }, false, true],
    ['user', { subcommand: 'user', values: { range: '365d' } }, false, true],
    ['apps', { subcommand: 'apps' }, false, false],
    ['apps for one app', { subcommand: 'apps', app: 'bot-a' }, false, false],
    ['emoji', { subcommand: 'emoji' }, false, false],
    ['sticker', { subcommand: 'sticker', values: { range: '90d' } }, false, false],
  ] as const)(
    '%s defers first and replies with the dashboard',
    async (_, options, hot, details) => {
      const { replies, order } = await run(options);
      expect(order[0]).toBe('defer');
      expect(order.length).toBeGreaterThan(1);
      expect(replies).toHaveLength(1);
      expectDashboard(replies[0], hot, details);
      expect(embedText(replies[0])).not.toMatch(/delet/i);
    },
  );

  it('caps member, channel and app rankings at 5 without a top_n option', async () => {
    const topN = (Action: { new (): { config: { options?: { integer?: unknown[] } } } }) =>
      new Action().config.options?.integer?.find(
        (option) => (option as { name: string }).name === 'top_n',
      );
    for (const Action of [TrafficOverview, TrafficChannel, TrafficMe, TrafficUser, TrafficApps])
      expect(topN(Action)).toBeUndefined();
    expect(RANK_ROW_LIMIT).toBe(5);
    expect(APP_RANK_LIMIT).toBe(5);

    for (const [subcommand, sections] of [
      ['overview', ['authors', 'channels']],
      ['me', ['channels', 'partners']],
    ] as const) {
      const { stats } = await run({ subcommand });
      const limits = stats.calls.find((call) => call.method === 'activity')?.limits ?? {};
      for (const section of sections) expect(limits[section], section).toBe(5);
    }
    const apps = await run({ subcommand: 'apps' });
    const usage = apps.stats.calls.filter((call) => call.method === 'appUsage');
    expect(usage[0]?.limits?.members).toBe(RANK_ROW_LIMIT);
  });

  it('defers publicly by default and ephemerally on request', async () => {
    expect((await run({ subcommand: 'overview' })).deferred[0]).toEqual({});
    const hidden = await run({ subcommand: 'overview', values: { visibility: 'ephemeral' } });
    expect(hidden.deferred[0]).toEqual({ flags: 64 });
  });

  it("keeps another member's report private unless asked to share it", async () => {
    expect((await run({ subcommand: 'user' })).deferred[0]).toEqual({ flags: 64 });
    const shared = await run({ subcommand: 'user', values: { visibility: 'public' } });
    expect(shared.deferred[0]).toEqual({});
  });

  it('counts only the invoker-visible channels for member statistics', async () => {
    const { stats } = await run({ subcommand: 'overview' });
    const scope = stats.calls.find((call) => call.method === 'activity')?.channelIds ?? [];
    expect(scope).toContain('c1');
    expect(scope).toContain('post-1');
    expect(scope).not.toContain('secret');
    expect(scope).not.toContain('c10');
  });

  it('filters /traffic user by the invoker while counting the target', async () => {
    const { stats } = await run({ subcommand: 'user', user: { id: 'a2', username: 'momo' } });
    const activity = stats.calls.find((call) => call.method === 'activity');
    expect(activity?.authorId).toBe('a2');
    expect(activity?.channelIds).not.toContain('secret');
    for (const call of stats.calls) expect(call.channelIds ?? []).not.toContain('secret');
  });

  it('counts the invoker for /traffic me', async () => {
    const { stats } = await run({ subcommand: 'me' });
    expect(stats.calls.find((call) => call.method === 'activity')?.authorId).toBe(INVOKER_ID);
  });

  it('counts every channel for emoji and stickers without reading the channel list', async () => {
    for (const subcommand of ['emoji', 'sticker']) {
      const { order } = await run({ subcommand });
      expect(order).not.toContain('listChannels');
      expect(order).not.toContain('activity');
    }
  });

  it('answers a hidden channel exactly like a missing one', async () => {
    const hidden = await run({ subcommand: 'channel', channel: 'secret' });
    const missing = await run({ subcommand: 'channel', channel: 'does-not-exist' });
    expect(hidden.replies).toEqual(privately('replies:traffic.channel_not_found'));
    expect(missing.replies).toEqual(hidden.replies);
    expect(hidden.order).not.toContain('activity');
  });

  it('caps a public reply by the command channel rank', async () => {
    const guild = fakeGuild({ invokerRoles: ['staff'] });
    const ephemeral = await run({
      subcommand: 'channel',
      channel: 'secret',
      guild,
      values: { visibility: 'ephemeral' },
    });
    expectDashboard(ephemeral.replies[0], true, true);
    const publicly = await run({
      subcommand: 'channel',
      channel: 'secret',
      guild,
      channelId: 'c1',
      values: { visibility: 'public' },
    });
    expect(publicly.replies).toEqual(privately('replies:traffic.channel_not_found'));
    const overview = await run({
      subcommand: 'overview',
      guild,
      values: { visibility: 'public' },
    });
    const scope = overview.stats.calls.find((call) => call.method === 'activity')?.channelIds;
    expect(scope).not.toContain('secret');
  });

  it('asks for a smaller range when the query times out', async () => {
    const stats = fakeStatsRepo();
    stats.activity = async () =>
      err(
        new DatabaseError({
          code: 'DATABASE_QUERY_TIMEOUT',
          messageKey: 'errors:db.query_timeout',
          context: { operation: 'test' },
        }),
      );
    // A translator that resolves keys, so the boundary keeps the error's own copy.
    const t = (key: string) => `<${key}>`;
    const { replies } = await run({ subcommand: 'overview', values: { range: '365d' } }, stats, t);
    expect(replies).toEqual([
      { deleted: true },
      { content: '<errors:db.query_timeout>', flags: 64 },
    ]);
  });

  it.each([
    ['overview', 'replies:traffic.no_data'],
    ['channel', 'replies:traffic.no_data'],
    ['me', 'replies:traffic.person_no_data'],
  ])('answers %s without activity with a notice and no image', async (subcommand, key) => {
    const { replies } = await run({ subcommand }, fakeStatsRepo({ messages: 0 }));
    expect(replies).toEqual(privately(key));
  });

  it('answers user without activity in its private reply', async () => {
    const { replies } = await run({ subcommand: 'user' }, fakeStatsRepo({ messages: 0 }));
    expect(replies).toEqual([{ content: 'replies:traffic.person_no_data' }]);
  });

  it('answers apps without interaction records with a notice', async () => {
    const { replies } = await run({ subcommand: 'apps' }, fakeStatsRepo({ appUses: 0 }));
    expect(replies).toEqual(privately('replies:traffic.apps_no_data'));
  });

  it('reads apps from interaction records only', async () => {
    const { order } = await run({ subcommand: 'apps' });
    expect(new Set(order.filter((step) => step !== 'defer'))).toEqual(
      new Set(['listChannels', 'appUsage']),
    );
  });

  it('answers a guild without emoji or stickers with a notice', async () => {
    const guild = fakeGuild({ emoji: 0, stickers: 0 });
    expect((await run({ subcommand: 'emoji', guild })).replies).toEqual(
      privately('replies:traffic.emoji_none'),
    );
    expect((await run({ subcommand: 'sticker', guild })).replies).toEqual(
      privately('replies:traffic.sticker_none'),
    );
  });

  it('refuses outside a guild privately, before deferring', async () => {
    const { replies, deferred } = await run({ subcommand: 'overview', guild: null });
    expect(replies).toEqual([{ content: 'errors:command.guild_not_found', flags: 64 }]);
    expect(deferred).toEqual([]);
  });

  it('keeps notices in the deferred reply when the report is ephemeral', async () => {
    const { replies } = await run(
      { subcommand: 'overview', values: { visibility: 'ephemeral' } },
      fakeStatsRepo({ messages: 0 }),
    );
    expect(replies).toEqual([{ content: 'replies:traffic.no_data' }]);
  });

  it.each([
    ['overview', { subcommand: 'overview' }],
    ['channel', { subcommand: 'channel', channel: 'c1' }],
    ['me', { subcommand: 'me' }],
    ['user', { subcommand: 'user' }],
    ['apps', { subcommand: 'apps' }],
    ['apps for one app', { subcommand: 'apps', app: 'bot-a' }],
  ] as const)('%s scopes every reader call to the visible channels', async (_, options) => {
    const { stats } = await run(options);
    const scoped = stats.calls.filter((call) => call.channelIds !== undefined);
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      // `secret` is above the invoker's rank, `pt1` is a private thread without
      // Manage Threads, and `c10` is uncached without a deleted record.
      expect(call.channelIds, call.method).not.toContain('secret');
      expect(call.channelIds, call.method).not.toContain('pt1');
      expect(call.channelIds, call.method).not.toContain('c10');
    }
    if (options.subcommand === 'apps')
      expect(scoped.filter((call) => call.method === 'appUsage').length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['a channel with its threads', { channel: 'c1' }, ['c1', 't1']],
    ['a channel without threads', { channel: 'c1', values: { include_threads: false } }, ['c1']],
    ['a selected thread', { channel: 't1' }, ['t1']],
  ] as const)('/traffic channel scans exactly %s', async (_, options, expected) => {
    const { stats } = await run({ subcommand: 'channel', ...options });
    const scope = stats.calls.find((call) => call.method === 'activity')?.channelIds;
    expect([...(scope ?? [])].sort()).toEqual(expected);
  });

  it('excludes the bots the client knows of from conversation partners', async () => {
    const { stats } = await run({ subcommand: 'me' });
    const excluded = stats.calls.find((call) => call.method === 'activity')?.excludeUserIds;
    expect(excluded).toEqual(expect.arrayContaining(['bot-a', 'bot-elsewhere']));
    expect(excluded).not.toContain('a1');
  });

  it('titles each report with its range and leaves out any summary or notes', async () => {
    const seen: { key: string; params?: Record<string, unknown> }[] = [];
    const t = (key: string, params?: Record<string, unknown>) => {
      seen.push({ key, ...(params === undefined ? {} : { params }) });
      return key;
    };
    const cases = [
      [{ subcommand: 'overview' }, 'overview'],
      [{ subcommand: 'channel', channel: 'c1' }, 'channel'],
      [{ subcommand: 'me' }, 'person'],
      [{ subcommand: 'apps' }, 'apps'],
      [{ subcommand: 'apps', app: 'bot-a' }, 'app'],
      [{ subcommand: 'emoji' }, 'emoji'],
      [{ subcommand: 'sticker' }, 'sticker'],
    ] as const;
    for (const [options, report] of cases) {
      seen.length = 0;
      const { replies } = await run(options, fakeStatsRepo(), t);
      expect(embedOf(replies[0])?.title).toBe(`replies:traffic.${report}.title`);
      const title = seen.find((call) => call.key === `replies:traffic.${report}.title`);
      expect(title?.params?.range, report).toBe(
        'replies:traffic.range.' + (report === 'emoji' || report === 'sticker' ? '30d' : '7d'),
      );
      expect(
        seen.some((call) => /\.(summary|notes)\b/.test(call.key)),
        report,
      ).toBe(false);
    }
  });

  it('names only visible channels in message previews', async () => {
    const stats = fakeStatsRepo({
      hotContent: 'see <#300000000000000003> and <#200000000000000001>',
    });
    // A short stand-in keeps both mentions inside the 30-character preview.
    const t = (key: string, params?: Record<string, unknown>) =>
      key === 'replies:traffic.unknown_channel' ? '??' : `${key}${JSON.stringify(params ?? {})}`;
    const { replies } = await run({ subcommand: 'overview' }, stats, t);
    const hot = embedText(replies[0]);
    expect(hot).toContain('see #?? and #活動公告');
    expect(hot).not.toContain('幹部閒聊');
    expect(hot).toContain('#活動公告');
  });

  it('runs one report per member and one long range per guild at a time', async () => {
    let releaseFirst: (() => void) | undefined;
    const slow = fakeStatsRepo();
    const original = slow.activity.bind(slow);
    slow.activity = (async (query: never) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return original(query);
    }) as typeof slow.activity;
    const first = run({ subcommand: 'overview', values: { range: '365d' } }, slow);
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    const sameMember = await run({ subcommand: 'me' });
    expect(sameMember.replies).toEqual([{ content: 'replies:traffic.busy_member', flags: 64 }]);
    const otherLong = fakeInteraction({ subcommand: 'overview', values: { range: '90d' } });
    (otherLong.interaction.user as { id: string }).id = 'a1';
    await new Traffic().execute(otherLong.interaction, fakeBot(fakeStatsRepo()));
    expect(otherLong.replies).toEqual([{ content: 'replies:traffic.busy_guild', flags: 64 }]);
    const otherShort = fakeInteraction({ subcommand: 'overview' });
    (otherShort.interaction.user as { id: string }).id = 'a1';
    await new Traffic().execute(otherShort.interaction, fakeBot(fakeStatsRepo()));
    expectDashboard(otherShort.replies[0], true, true);
    releaseFirst?.();
    expectDashboard((await first).replies[0], true, true);
    expectDashboard((await run({ subcommand: 'me' })).replies[0], false, true);
  });
});
