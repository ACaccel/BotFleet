/**
 * Handler coverage for every `/traffic` subcommand, run through the grouped
 * root with a fake statistics reader and the real dashboard renderers. CDN
 * downloads are stubbed to fail, so every reply also proves a missing picture
 * never fails the image.
 *
 * Pinned contracts: the reply is deferred before any query; one embed carries
 * the dashboard PNG (overview and channel add the top-messages embed); member
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

const expectDashboard = (reply: Reply | undefined, embeds: number): void => {
  expect(reply?.content).toBeUndefined();
  expect(reply?.embeds).toHaveLength(embeds);
  const first = reply?.embeds?.[0]?.toJSON() as { image?: { url: string } } | undefined;
  const file = reply?.files?.[0];
  expect(reply?.files).toHaveLength(1);
  expect(first?.image?.url).toBe(`attachment://${String(file?.name)}`);
  expect((reply as { allowedMentions?: unknown } | undefined)?.allowedMentions).toEqual({
    parse: [],
  });
  expect((file?.attachment as Buffer).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
};

describe('/traffic subcommands', () => {
  it.each([
    ['overview', { subcommand: 'overview' }, 2],
    ['channel', { subcommand: 'channel', channel: 'c1' }, 2],
    [
      'channel without threads',
      { subcommand: 'channel', channel: 'c2', values: { range: '30d' } },
      2,
    ],
    ['me', { subcommand: 'me', values: { range: '24h' } }, 1],
    ['user', { subcommand: 'user', values: { range: '365d' } }, 1],
    ['apps', { subcommand: 'apps' }, 1],
    ['apps for one app', { subcommand: 'apps', app: 'bot-a' }, 1],
    ['emoji', { subcommand: 'emoji' }, 1],
    ['sticker', { subcommand: 'sticker', values: { range: '90d' } }, 1],
  ] as const)('%s defers first and replies with the dashboard', async (_, options, embeds) => {
    const { replies, order } = await run(options);
    expect(order[0]).toBe('defer');
    expect(order.length).toBeGreaterThan(1);
    expect(replies).toHaveLength(1);
    expectDashboard(replies[0], embeds);
    expect(embedText(replies[0])).not.toMatch(/delet/i);
  });

  it('defers ephemerally by default and publicly on request', async () => {
    expect((await run({ subcommand: 'overview' })).deferred[0]).toEqual({ flags: 64 });
    const shown = await run({ subcommand: 'overview', values: { visibility: 'public' } });
    expect(shown.deferred[0]).toEqual({});
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
    expect(hidden.replies).toEqual([{ content: 'replies:traffic.channel_not_found' }]);
    expect(missing.replies).toEqual(hidden.replies);
    expect(hidden.order).not.toContain('activity');
  });

  it('caps a public reply by the command channel rank', async () => {
    const guild = fakeGuild({ invokerRoles: ['staff'] });
    const privately = await run({ subcommand: 'channel', channel: 'secret', guild });
    expectDashboard(privately.replies[0], 2);
    const publicly = await run({
      subcommand: 'channel',
      channel: 'secret',
      guild,
      channelId: 'c1',
      values: { visibility: 'public' },
    });
    expect(publicly.replies).toEqual([{ content: 'replies:traffic.channel_not_found' }]);
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
    expect(replies).toEqual([{ content: '<errors:db.query_timeout>' }]);
  });

  it.each([
    ['overview', 'replies:traffic.no_data'],
    ['channel', 'replies:traffic.no_data'],
    ['me', 'replies:traffic.person_no_data'],
    ['user', 'replies:traffic.person_no_data'],
  ])('answers %s without activity with a notice and no image', async (subcommand, key) => {
    const { replies } = await run({ subcommand }, fakeStatsRepo({ messages: 0 }));
    expect(replies).toEqual([{ content: key }]);
  });

  it('answers apps without interaction records with a notice', async () => {
    const { replies } = await run({ subcommand: 'apps' }, fakeStatsRepo({ appUses: 0 }));
    expect(replies).toEqual([{ content: 'replies:traffic.apps_no_data' }]);
  });

  it('reads apps from interaction records only', async () => {
    const { order } = await run({ subcommand: 'apps' });
    expect(new Set(order.filter((step) => step !== 'defer'))).toEqual(
      new Set(['listChannels', 'fullBackupCompleted', 'appUsage']),
    );
  });

  it('answers a guild without emoji or stickers with a notice', async () => {
    const guild = fakeGuild({ emoji: 0, stickers: 0 });
    expect((await run({ subcommand: 'emoji', guild })).replies).toEqual([
      { content: 'replies:traffic.emoji_none' },
    ]);
    expect((await run({ subcommand: 'sticker', guild })).replies).toEqual([
      { content: 'replies:traffic.sticker_none' },
    ]);
  });

  it('refuses outside a guild', async () => {
    const { replies } = await run({ subcommand: 'overview', guild: null });
    expect(replies).toEqual([{ content: 'errors:command.guild_not_found' }]);
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

  it('notes incomplete statistics only while no full backup has completed', async () => {
    const footer = (reply: Reply | undefined): string =>
      String((reply?.embeds?.[0]?.toJSON() as { footer?: { text?: string } }).footer?.text);
    for (const subcommand of ['overview', 'me']) {
      const rebuilding = await run({ subcommand }, fakeStatsRepo({ rebuilding: true }));
      expect(footer(rebuilding.replies[0])).toContain('replies:traffic.notes.rebuild');
      const done = await run({ subcommand });
      expect(footer(done.replies[0])).not.toContain('replies:traffic.notes.rebuild');
    }
    const emoji = await run({ subcommand: 'emoji' }, fakeStatsRepo({ rebuilding: true }));
    expect(footer(emoji.replies[0])).not.toContain('replies:traffic.notes.rebuild');
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
    expectDashboard(otherShort.replies[0], 2);
    releaseFirst?.();
    expectDashboard((await first).replies[0], 2);
    expectDashboard((await run({ subcommand: 'me' })).replies[0], 1);
  });
});
