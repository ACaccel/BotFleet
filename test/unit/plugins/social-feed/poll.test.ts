/**
 * Unit tests for one social-feed pass.
 *
 * Three invariants are under test. **Cursor discipline**: the cursor
 * advances only past posts that actually reached Discord, so a failed
 * send is retried rather than skipped, and a fresh subscription never
 * backfills nor swallows a genuinely new post. **Shared reads**: one
 * `(platform, account)` pair costs exactly one upstream request per
 * pass however many guilds and channels follow it, and the `since` hint
 * that request carries must not hide posts from the subscription with
 * the oldest cursor. **Failure isolation**: a pass survives a bad
 * guild, subscription, upstream, or send, and says so in the log rather
 * than going quiet.
 *
 * The whole suite drives a fake platform rather than X — which is the
 * executable evidence that the poller is platform-neutral, since a
 * platform the shipped union never names completes the full path from
 * subscription to delivered message.
 */
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Channel, Client } from 'discord.js';
import { Types } from 'mongoose';

import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';
import { runFeedPass, type FeedPassDeps } from '../../../../src/plugins/social-feed/internal';
import { parseSocialFeedConfig } from '../../../../src/plugins/social-feed/config';
import {
  FeedPlatformRegistry,
  type FeedPlatform,
  type FeedPost,
} from '../../../../src/infra/social-feed';
import type { GuildRegistry } from '../../../../src/bot/guild-registry';
import type { Translator } from '../../../../src/core/i18n';
import type { Logger } from '../../../../src/core/logger';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';
import type { Repos } from '../../../../src/persistence/repositories';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { createFakeClock } from '../../../../src/core/time';
import { ok, err } from '../../../../src/core/result';
import { DatabaseError, FeedError } from '../../../../src/core/errors';
import type { FeedPreview } from '../../../../src/infra/social-feed';

const ACCOUNT = 'someaccount';
const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const NOW_MS = 1_787_800_000_000;
const PHOTO = { kind: 'photo', url: 'https://cdn.invalid/a.jpg' } as const;

const fakeTranslator: Translator = {
  ...echoTranslator(),
  t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
};

/**
 * Logger whose children are itself, so `logError`'s `.child()` call is
 * observable. Child bindings are recorded rather than discarded, so a
 * regression that dropped or mis-passed the `guildId` scope is visible
 * and not just the call count.
 */
const makeLogger = (): {
  logger: Logger;
  error: MockInstance;
  warn: MockInstance;
  bindings: Record<string, unknown>[];
} => {
  const logger = silentLogger();
  const bindings: Record<string, unknown>[] = [];
  vi.spyOn(logger, 'child').mockImplementation((b) => {
    bindings.push(b);
    return logger;
  });
  return { logger, error: vi.spyOn(logger, 'error'), warn: vi.spyOn(logger, 'warn'), bindings };
};

/** A post the default (`media_only`) filter accepts. */
const post = (overrides: Partial<FeedPost> & Pick<FeedPost, 'id'>): FeedPost =>
  buildFeedPost({
    authorAccount: ACCOUNT,
    createdTimestamp: Number(overrides.id) * 10,
    media: [PHOTO],
    ...overrides,
  });

/** A stored subscription with the defaults every case starts from. */
const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc =>
  ({
    _id: new Types.ObjectId(),
    platform: 'fake',
    account: ACCOUNT,
    channel_id: CHANNEL,
    created_by: 'user-1',
    created_at: NOW_MS,
    filter: { media: 'media_only' },
    ...overrides,
  }) as FeedSubscriptionDoc;

interface ReposHandle {
  readonly repos: Repos;
  readonly advanceCursor: ReturnType<typeof vi.fn>;
  readonly deleteWhere: ReturnType<typeof vi.fn>;
  /** Cursor state as the fake store holds it, keyed by subscription id. */
  cursorOf(sub: FeedSubscriptionDoc): { id: string; timestamp: number } | undefined;
}

/** In-memory subscription repo plus the spies each case asserts on. */
const makeRepos = (
  subs: readonly FeedSubscriptionDoc[],
  overrides: { listFails?: boolean; advanceFails?: boolean } = {},
): ReposHandle => {
  const cursors = new Map<string, { id: string; timestamp: number }>();
  const advanceCursor = vi.fn(async (id: Types.ObjectId, lastSeenId: string, ts: number) => {
    if (overrides.advanceFails === true) {
      return err(
        new DatabaseError({
          code: 'DATABASE_UNKNOWN',
          messageKey: 'errors:db.unavailable',
          context: { operation: 'test' },
        }),
      );
    }
    cursors.set(id.toString(), { id: lastSeenId, timestamp: ts });
    return ok(undefined);
  });
  const deleteWhere = vi.fn(async () => ok([]));
  const repos = {
    feedSubscription: {
      list: async () =>
        overrides.listFails === true
          ? err(
              new DatabaseError({
                code: 'DATABASE_TIMEOUT',
                messageKey: 'errors:db.timeout',
                context: { operation: 'test' },
              }),
            )
          : // Reads reflect what earlier passes wrote, so a
            // seed-then-forward sequence can be driven end to end.
            ok(
              subs.map((sub) => {
                const cursor = cursors.get(sub._id.toString());
                return cursor === undefined
                  ? sub
                  : { ...sub, last_seen_id: cursor.id, last_seen_timestamp: cursor.timestamp };
              }),
            ),
      advanceCursor,
      deleteWhere,
    },
  } as unknown as Repos;
  return {
    repos,
    advanceCursor,
    deleteWhere,
    cursorOf: (sub) => cursors.get(sub._id.toString()),
  };
};

/** Payload shape `sendFeedPost` hands to `channel.send`. */
interface SendPayload {
  readonly content: string;
  readonly allowedMentions: unknown;
}
type SendSpy = ReturnType<typeof vi.fn<(payload: SendPayload) => Promise<undefined>>>;

const makeSend = (): SendSpy => vi.fn(async () => undefined);

const makeChannel = (send: SendSpy, sendable = true): Channel =>
  ({ isSendable: () => sendable, send }) as unknown as Channel;

/**
 * Client whose channel lookup goes through the owning guild, matching
 * the production path: a channel is reachable only from the guild that
 * holds it, so a stored id can never address another guild's channel.
 */
const makeClient = (guildChannels: ReadonlyMap<string, ReadonlyMap<string, Channel>>): Client =>
  ({
    guilds: {
      cache: {
        get: (guildId: string) => {
          const channels = guildChannels.get(guildId);
          return channels === undefined
            ? undefined
            : { channels: { cache: { get: (id: string) => channels.get(id) } } };
        },
      },
    },
  }) as unknown as Client;

interface HarnessInput {
  readonly posts?: readonly FeedPost[];
  readonly fetchFails?: boolean;
  /** Guilds in the registry, each with its own repo handle. */
  readonly guilds?: ReadonlyMap<string, Repos | undefined>;
  readonly repos?: Repos;
  /** Channels of the default guild, keyed by channel id. */
  readonly channels?: ReadonlyMap<string, Channel>;
  readonly channel?: Channel;
  /** Full control: channels per guild, for the multi-guild cases. */
  readonly guildChannels?: ReadonlyMap<string, ReadonlyMap<string, Channel>>;
  /** Platforms the registry holds; defaults to the single fake platform. */
  readonly registerFakePlatform?: boolean;
  /** Additional platforms registered alongside the default fake one. */
  readonly extraPlatforms?: readonly FeedPlatform[];
  /** Guild id whose `getRepos` throws, for the collection-boundary case. */
  readonly throwForGuild?: string;
  readonly maxPostsPerPoll?: number;
}

const harness = (
  input: HarnessInput = {},
): {
  deps: FeedPassDeps;
  fetchTimeline: ReturnType<typeof vi.fn>;
  errorLog: MockInstance;
  warnLog: MockInstance;
  logBindings: Record<string, unknown>[];
} => {
  const fake = buildFakeFeedPlatform({
    posts: input.posts ?? [],
    failWith:
      input.fetchFails === true
        ? new FeedError({
            code: 'FEED_NOT_FOUND',
            messageKey: 'errors:feed.not_found',
            context: { operation: 'test' },
          })
        : undefined,
  });
  const platforms = new FeedPlatformRegistry([
    ...(input.registerFakePlatform === false ? [] : [fake.platform]),
    ...(input.extraPlatforms ?? []),
  ]);

  const guilds = input.guilds ?? new Map([[GUILD, input.repos]]);
  const registry: GuildRegistry = {
    listGuildIds: () => [...guilds.keys()],
    getRepos: (guildId: string) => {
      if (guildId === input.throwForGuild) throw new Error('registry exploded');
      return guilds.get(guildId);
    },
    getChannel: () => undefined,
    getRole: () => undefined,
  };

  const channels =
    input.channels ?? new Map(input.channel === undefined ? [] : [[CHANNEL, input.channel]]);
  // Every channel belongs to the default guild unless a case says
  // otherwise; the multi-guild cases pass `guildChannels` directly.
  const client = makeClient(input.guildChannels ?? new Map([[GUILD, channels]]));

  const config = parseSocialFeedConfig({
    enabled: true,
    platforms: { x: {} },
    maxPostsPerPoll: input.maxPostsPerPoll ?? 5,
  });

  const { logger, error, warn, bindings } = makeLogger();
  return {
    deps: {
      platforms,
      registry,
      client,
      translator: fakeTranslator,
      logger,
      clock: createFakeClock(NOW_MS),
      config,
    },
    fetchTimeline: fake.fetchTimeline,
    errorLog: error,
    warnLog: warn,
    logBindings: bindings,
  };
};

describe('runFeedPass — a fake platform end to end', () => {
  it('carries a subscription on a platform outside the shipped union all the way to a message', async () => {
    // The framework's promise of neutrality, executed: no XPlatform, no
    // HTTP, no snowflake arithmetic — only the FeedPlatform contract.
    const send = makeSend();
    const sub = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({ posts: [post({ id: '10' })], repos, channel: makeChannel(send) });

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].content).toContain('https://fake.invalid/10');
    expect(send.mock.calls[0]?.[0].allowedMentions).toEqual({ parse: [] });
    expect(cursorOf(sub)).toEqual({ id: '10', timestamp: 100 });
  });
});

describe('runFeedPass — shared upstream reads', () => {
  it('reads one account once per pass however many guilds subscribe to it', async () => {
    const sendA = makeSend();
    const sendB = makeSend();
    const subA = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const subB = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const a = makeRepos([subA]);
    const b = makeRepos([subB]);
    const { deps, fetchTimeline } = harness({
      posts: [post({ id: '10' })],
      guilds: new Map([
        ['g-a', a.repos],
        ['g-b', b.repos],
      ]),
      guildChannels: new Map([
        ['g-a', new Map([[CHANNEL, makeChannel(sendA)]])],
        ['g-b', new Map([['channel-2', makeChannel(sendB)]])],
      ]),
    });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledTimes(1);
    // Each subscription still advances its own cursor.
    expect(a.cursorOf(subA)?.id).toBe('10');
    expect(b.cursorOf(subB)?.id).toBe('10');
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('reads one account once per pass however many channels in one guild subscribe to it', async () => {
    const send = makeSend();
    const first = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const second = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos, cursorOf } = makeRepos([first, second]);
    const { deps, fetchTimeline } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(send)],
        ['channel-2', makeChannel(send)],
      ]),
    });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(cursorOf(first)?.id).toBe('10');
    expect(cursorOf(second)?.id).toBe('10');
  });

  it('reads two different accounts separately', async () => {
    const other = subscription({
      account: 'otheraccount',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const mine = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos } = makeRepos([mine, other]);
    const { deps, fetchTimeline } = harness({ repos, channel: makeChannel(makeSend()) });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledTimes(2);
  });

  it('sends the smallest cursor timestamp in the group as `since`', async () => {
    // `since` gates the 204 and does not filter, so a higher value could
    // report "nothing newer" for the whole group while the subscription
    // with the older cursor still had posts to receive.
    const behind = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const ahead = subscription({
      channel_id: 'channel-2',
      last_seen_id: '9',
      last_seen_timestamp: 90,
    });
    const { repos } = makeRepos([behind, ahead]);
    const { deps, fetchTimeline } = harness({ repos, channel: makeChannel(makeSend()) });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledWith(ACCOUNT, { sinceTimestamp: 50 });
  });

  it('takes the smallest cursor across guilds, not just within one', async () => {
    const behind = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const ahead = subscription({ last_seen_id: '9', last_seen_timestamp: 90 });
    const { deps, fetchTimeline } = harness({
      guilds: new Map([
        ['g-ahead', makeRepos([ahead]).repos],
        ['g-behind', makeRepos([behind]).repos],
      ]),
      channel: makeChannel(makeSend()),
    });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledWith(ACCOUNT, { sinceTimestamp: 50 });
  });

  it('drops `since` when any subscription in the group has no cursor yet', async () => {
    const seeded = subscription({ last_seen_id: '9', last_seen_timestamp: 90 });
    const fresh = subscription({ channel_id: 'channel-2' });
    const { repos } = makeRepos([seeded, fresh]);
    const { deps, fetchTimeline } = harness({ repos, channel: makeChannel(makeSend()) });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledWith(ACCOUNT, { sinceTimestamp: undefined });
  });

  it('keeps one account name on two platforms in separate groups', async () => {
    // The grouping key must carry the platform: two platforms hosting
    // the same account name would otherwise collapse into one read and
    // cross-deliver each other's posts.
    const fakeSend = makeSend();
    const otherSend = makeSend();
    const other = buildFakeFeedPlatform({
      id: 'fake2',
      posts: [post({ id: '11' })],
    });
    const onFake = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const onOther = subscription({
      platform: 'fake2',
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos } = makeRepos([onFake, onOther]);
    const { deps, fetchTimeline } = harness({
      posts: [post({ id: '10' })],
      repos,
      extraPlatforms: [other.platform],
      channels: new Map([
        [CHANNEL, makeChannel(fakeSend)],
        ['channel-2', makeChannel(otherSend)],
      ]),
    });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledTimes(1);
    expect(other.fetchTimeline).toHaveBeenCalledTimes(1);
    expect(fakeSend.mock.calls[0]?.[0].content).toContain('/10');
    expect(otherSend.mock.calls[0]?.[0].content).toContain('/11');
  });

  it('treats two spellings of one account as a single group', async () => {
    // Accounts are normalised on write and compared case-insensitively
    // everywhere else, so a legacy document differing only in case must
    // not cost a second upstream read.
    const upper = subscription({
      account: 'SomeAccount',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const lower = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos } = makeRepos([upper, lower]);
    const { deps, fetchTimeline } = harness({
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(makeSend())],
        ['channel-2', makeChannel(makeSend())],
      ]),
    });

    await runFeedPass(deps, false);

    expect(fetchTimeline).toHaveBeenCalledTimes(1);
  });

  it('drops `since` on a full sweep so a same-second post cannot hide', async () => {
    const { repos } = makeRepos([subscription({ last_seen_id: '9', last_seen_timestamp: 90 })]);
    const { deps, fetchTimeline } = harness({ repos, channel: makeChannel(makeSend()) });

    await runFeedPass(deps, true);

    expect(fetchTimeline).toHaveBeenCalledWith(ACCOUNT, { sinceTimestamp: undefined });
  });
});

describe('runFeedPass — seeding a new subscription', () => {
  it('records the baseline and posts nothing', async () => {
    const send = makeSend();
    const sub = subscription();
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({
      posts: [post({ id: '10' }), post({ id: '30' })],
      repos,
      channel: makeChannel(send),
    });

    await runFeedPass(deps, false);

    expect(send).not.toHaveBeenCalled();
    expect(cursorOf(sub)).toEqual({ id: '30', timestamp: 300 });
  });

  it('seeds an empty timeline from the platform id floor, not from zero', async () => {
    // A '0' baseline is below every post ever published, so the next
    // full sweep — which drops `since` and returns the whole page —
    // would drain the account's back catalogue into the channel.
    const sub = subscription();
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({ posts: [], repos, channel: makeChannel(makeSend()) });

    await runFeedPass(deps, false);

    expect(cursorOf(sub)).toEqual({ id: String(NOW_MS), timestamp: Math.floor(NOW_MS / 1000) });
  });

  it('records the baseline even when the channel is unusable', async () => {
    // Seeding sends nothing, so a broken channel must not leave the
    // subscription unseeded: an unseeded member drops the `since` hint
    // for every other subscriber of the same account.
    const sub = subscription();
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps, warnLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map(),
    });

    await runFeedPass(deps, false);

    expect(cursorOf(sub)?.id).toBe('10');
    // Nothing was due for delivery, so the broken channel is not worth
    // a log line yet.
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('does not backfill pre-existing posts on the full sweep after an empty first page', async () => {
    // The historical bug: a zero baseline sits below every post ever
    // published, so the next sweep — which drops `since` and returns the
    // whole page — drained the account's back catalogue into the channel.
    const send = makeSend();
    const { repos } = makeRepos([subscription()]);
    const channels = new Map([[CHANNEL, makeChannel(send)]]);
    const backlog = [post({ id: '1787000000000' }), post({ id: '1787700000000' })];

    await runFeedPass(harness({ posts: [], repos, channels }).deps, false);
    await runFeedPass(harness({ posts: backlog, repos, channels }).deps, true);

    expect(send).not.toHaveBeenCalled();
  });

  it('still forwards a post published after an empty first page', async () => {
    const send = makeSend();
    const { repos } = makeRepos([subscription()]);
    const channels = new Map([[CHANNEL, makeChannel(send)]]);

    await runFeedPass(harness({ posts: [], repos, channels }).deps, false);
    // Published after the baseline was taken, so it is genuinely new.
    const fresh = [post({ id: '1787900000000' })];
    await runFeedPass(harness({ posts: fresh, repos, channels }).deps, false);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('logs and skips when the baseline write fails', async () => {
    const { repos } = makeRepos([subscription()], { advanceFails: true });
    const { deps, errorLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channel: makeChannel(makeSend()),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});

describe('runFeedPass — forwarding', () => {
  it('forwards new posts oldest-first and advances the cursor to the last one', async () => {
    const send = makeSend();
    const sub = subscription({ last_seen_id: '10', last_seen_timestamp: 100 });
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({
      posts: [post({ id: '30' }), post({ id: '20' })],
      repos,
      channel: makeChannel(send),
    });

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(2);
    const sent = send.mock.calls.map((c) => c[0].content);
    expect(sent[0]).toContain('/20');
    expect(sent[1]).toContain('/30');
    expect(cursorOf(sub)?.id).toBe('30');
  });

  it('applies each subscription’s own filter to the shared page', async () => {
    const photoSend = makeSend();
    const videoSend = makeSend();
    const photoSub = subscription({
      filter: { media: 'photo_only' },
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const videoSub = subscription({
      channel_id: 'channel-2',
      filter: { media: 'video_only' },
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos } = makeRepos([photoSub, videoSub]);
    const { deps } = harness({
      posts: [
        post({ id: '10', media: [PHOTO] }),
        post({ id: '11', media: [{ kind: 'video', url: 'https://cdn.invalid/a.mp4' }] }),
      ],
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(photoSend)],
        ['channel-2', makeChannel(videoSend)],
      ]),
    });

    await runFeedPass(deps, false);

    expect(photoSend.mock.calls.map((c) => c[0].content)).toHaveLength(1);
    expect(photoSend.mock.calls[0]?.[0].content).toContain('/10');
    expect(videoSend.mock.calls[0]?.[0].content).toContain('/11');
  });

  it('sends nothing and leaves the cursor alone when there is nothing new', async () => {
    const send = makeSend();
    const { repos, advanceCursor } = makeRepos([
      subscription({ last_seen_id: '30', last_seen_timestamp: 300 }),
    ]);
    const { deps } = harness({
      posts: [post({ id: '30' }), post({ id: '20' })],
      repos,
      channel: makeChannel(send),
    });

    await runFeedPass(deps, false);

    expect(send).not.toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('honours the per-pass cap, leaving the remainder for the next pass', async () => {
    const send = makeSend();
    const sub = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({
      posts: [post({ id: '10' }), post({ id: '20' }), post({ id: '30' })],
      repos,
      channel: makeChannel(send),
      maxPostsPerPoll: 2,
    });

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(2);
    // The cursor stops at the last delivered post, so 30 is still pending.
    expect(cursorOf(sub)?.id).toBe('20');
  });
});

describe('runFeedPass — failure isolation', () => {
  const previewOf = (item: FeedPost): FeedPreview => ({
    kind: 'post',
    sourceUrl: item.url,
    post: {
      url: item.url,
      text: 'Post text',
      createdAt: item.createdTimestamp * 1000,
      author: {
        name: item.authorAccount,
        handle: item.authorAccount,
        url: `https://x.com/${item.authorAccount}`,
      },
      images: ['https://cdn.example/photo.jpg'],
      stats: {},
    },
  });

  it.each([0, 1])(
    'advances only over delivered custom cards when send %s fails',
    async (successfulSends) => {
      const send = makeSend();
      send.mockRejectedValue(new Error('Missing Permissions'));
      if (successfulSends === 1) send.mockResolvedValueOnce(undefined);
      const sub = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
      const { repos, cursorOf, advanceCursor } = makeRepos([sub]);
      const { deps, errorLog } = harness({
        posts: [post({ id: '10' }), post({ id: '20' })],
        repos,
        channel: makeChannel(send),
      });
      const platform = deps.platforms.get('fake')!;
      platform.buildPreview = vi.fn(async (item) => ok(previewOf(item)));

      await runFeedPass(deps, false);
      expect(cursorOf(sub)?.id).toBe(successfulSends === 0 ? undefined : '10');
      expect(advanceCursor).toHaveBeenCalledTimes(successfulSends);
      expect(send).toHaveBeenCalledTimes(successfulSends + 1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  it('shares one preview read across destinations and prepares again on the next pass', async () => {
    const first = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const second = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos, cursorOf } = makeRepos([first, second]);
    const firstSend = makeSend().mockRejectedValue(new Error('Missing Permissions'));
    const secondSend = makeSend();
    const { deps } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(firstSend)],
        ['channel-2', makeChannel(secondSend)],
      ]),
    });
    const buildPreview = vi.fn(async (item: FeedPost) => ok(previewOf(item)));
    deps.platforms.get('fake')!.buildPreview = buildPreview;

    await runFeedPass(deps, false);
    expect(buildPreview).toHaveBeenCalledTimes(1);
    expect(cursorOf(first)).toBeUndefined();
    expect(cursorOf(second)?.id).toBe('10');
    expect(secondSend.mock.calls[0]?.[0]).toHaveProperty('embeds');
    expect(secondSend.mock.calls[0]?.[0].content).toContain('<https://fake.invalid/');
    expect(secondSend.mock.calls[0]?.[0].content).not.toContain('<<');

    firstSend.mockResolvedValue(undefined);
    await runFeedPass(deps, false);
    expect(buildPreview).toHaveBeenCalledTimes(2);
    expect(cursorOf(first)?.id).toBe('10');
    expect(secondSend).toHaveBeenCalledTimes(1);
  });

  it('delivers the existing proxy announcement when every preview source is unavailable', async () => {
    const send = makeSend();
    const sub = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps } = harness({ posts: [post({ id: '10' })], repos, channel: makeChannel(send) });
    deps.platforms.get('fake')!.buildPreview = vi.fn(async () => ok(null));
    await runFeedPass(deps, false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].content).toContain('https://fake.invalid/10');
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('embeds');
    expect(cursorOf(sub)?.id).toBe('10');
  });

  it('advances the cursor to the last delivered post when a later send fails', async () => {
    const send = vi
      .fn<(payload: SendPayload) => Promise<undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('Missing Permissions'));
    const sub = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos, cursorOf } = makeRepos([sub]);
    const { deps, errorLog } = harness({
      posts: [post({ id: '10' }), post({ id: '20' })],
      repos,
      channel: makeChannel(send),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();

    // 10 went out, 20 did not — the cursor must not step over 20, and
    // the failure must be visible rather than a feed that simply stopped.
    expect(cursorOf(sub)?.id).toBe('10');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('leaves the cursor untouched when the very first send fails', async () => {
    const send = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const { repos, advanceCursor } = makeRepos([
      subscription({ last_seen_id: '5', last_seen_timestamp: 50 }),
    ]);
    const { deps } = harness({ posts: [post({ id: '10' })], repos, channel: makeChannel(send) });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('scopes a send failure to the guild it happened in', async () => {
    const send = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const { repos } = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })]);
    const { deps, logBindings } = harness({
      posts: [post({ id: '10' })],
      guilds: new Map([['g-scoped', repos]]),
      guildChannels: new Map([['g-scoped', new Map([[CHANNEL, makeChannel(send)]])]]),
    });

    await runFeedPass(deps, false);

    expect(logBindings).toContainEqual({ guildId: 'g-scoped' });
  });

  it('keeps polling later subscriptions after one throws', async () => {
    const send = vi
      .fn<(payload: SendPayload) => Promise<undefined>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const first = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const second = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos, cursorOf } = makeRepos([first, second]);
    const { deps } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(send)],
        ['channel-2', makeChannel(send)],
      ]),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(cursorOf(first)).toBeUndefined();
    expect(cursorOf(second)?.id).toBe('10');
  });

  it('skips a guild that has no database', async () => {
    const { deps, fetchTimeline } = harness({ repos: undefined });
    await runFeedPass(deps, false);
    expect(fetchTimeline).not.toHaveBeenCalled();
  });

  it('skips a guild whose subscription read fails, and logs it', async () => {
    const { repos } = makeRepos([subscription()], { listFails: true });
    const { deps, fetchTimeline, errorLog } = harness({ repos, channel: makeChannel(makeSend()) });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('keeps polling other guilds after one guild’s subscription read fails', async () => {
    const send = makeSend();
    const healthy = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })]);
    const { deps } = harness({
      posts: [post({ id: '10' })],
      guilds: new Map([
        ['g-broken', makeRepos([subscription()], { listFails: true }).repos],
        ['g-healthy', healthy.repos],
      ]),
      guildChannels: new Map([['g-healthy', new Map([[CHANNEL, makeChannel(send)]])]]),
    });

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a subscription whose timeline read fails, leaving the cursor alone and logging it', async () => {
    const { repos, advanceCursor } = makeRepos([
      subscription({ last_seen_id: '5', last_seen_timestamp: 50 }),
    ]);
    const { deps, errorLog } = harness({
      fetchFails: true,
      repos,
      channel: makeChannel(makeSend()),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(advanceCursor).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('keeps polling other accounts after one account’s timeline read fails', async () => {
    const send = makeSend();
    const broken = subscription({ account: 'aaa', last_seen_id: '5', last_seen_timestamp: 50 });
    const healthy = subscription({
      account: 'bbb',
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos } = makeRepos([broken, healthy]);
    const { deps, fetchTimeline, errorLog } = harness({
      posts: [post({ id: '10', authorAccount: 'bbb' })],
      repos,
      channels: new Map([
        [CHANNEL, makeChannel(makeSend())],
        ['channel-2', makeChannel(send)],
      ]),
    });
    fetchTimeline.mockResolvedValueOnce(
      err(
        new FeedError({
          code: 'FEED_NOT_FOUND',
          messageKey: 'errors:feed.not_found',
          context: { operation: 'test' },
        }),
      ),
    );

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    // The upstream failure must reach the log as itself, not as some
    // generic wrapper an operator cannot act on.
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({ err: { code: 'FEED_NOT_FOUND' } });
  });

  it('keeps serving the other subscribers when one channel is unresolvable', async () => {
    const send = makeSend();
    const broken = subscription({ last_seen_id: '5', last_seen_timestamp: 50 });
    const working = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos, cursorOf } = makeRepos([broken, working]);
    const { deps, warnLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map([['channel-2', makeChannel(send)]]),
    });

    await runFeedPass(deps, false);

    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(cursorOf(working)?.id).toBe('10');
    expect(cursorOf(broken)).toBeUndefined();
  });

  it('warns once per guild rather than once per bot for an unconfigured platform', async () => {
    const a = makeRepos([subscription()]);
    const b = makeRepos([subscription()]);
    const { deps, warnLog } = harness({
      guilds: new Map([
        ['g-a', a.repos],
        ['g-b', b.repos],
      ]),
      registerFakePlatform: false,
    });

    await runFeedPass(deps, false);

    expect(warnLog).toHaveBeenCalledTimes(2);
    expect(warnLog.mock.calls.map((c) => (c[0] as { guildId: string }).guildId)).toEqual([
      'g-a',
      'g-b',
    ]);
  });

  it('does not let an unconfigured platform suppress a guild’s other subscriptions', async () => {
    const send = makeSend();
    const missing = subscription({ platform: 'missing' });
    const usable = subscription({
      channel_id: 'channel-2',
      last_seen_id: '5',
      last_seen_timestamp: 50,
    });
    const { repos } = makeRepos([missing, usable]);
    const { deps } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map([['channel-2', makeChannel(send)]]),
    });

    await runFeedPass(deps, false);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('warns once per guild and platform when the platform is not configured', async () => {
    const { repos, advanceCursor } = makeRepos([
      subscription(),
      subscription({ channel_id: 'channel-2' }),
    ]);
    const { deps, warnLog } = harness({
      repos,
      channel: makeChannel(makeSend()),
      registerFakePlatform: false,
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog.mock.calls[0]?.[0]).toMatchObject({ guildId: GUILD, platform: 'fake' });
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('warns and skips when the channel id no longer resolves', async () => {
    const { repos, advanceCursor, deleteWhere } = makeRepos([
      subscription({ last_seen_id: '5', last_seen_timestamp: 50 }),
    ]);
    const { deps, warnLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channels: new Map(),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(advanceCursor).not.toHaveBeenCalled();
    // A missing channel is usually a transient permission loss, so the
    // subscription must survive it rather than be silently deleted.
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('warns and skips a channel that resolves but is not sendable', async () => {
    const { repos, advanceCursor, deleteWhere } = makeRepos([
      subscription({ last_seen_id: '5', last_seen_timestamp: 50 }),
    ]);
    const { deps, warnLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channel: makeChannel(makeSend(), false),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(advanceCursor).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('never delivers into a channel belonging to another guild', async () => {
    // Each guild owns its own database, so a stored channel id may only
    // ever address a channel of the guild that stored it — a global
    // channel lookup would leak one guild's feed into another's.
    const send = makeSend();
    const { repos, advanceCursor } = makeRepos([
      subscription({ last_seen_id: '5', last_seen_timestamp: 50 }),
    ]);
    const { deps, warnLog } = harness({
      posts: [post({ id: '10' })],
      guilds: new Map([['g-owner', repos]]),
      guildChannels: new Map([['g-other', new Map([[CHANNEL, makeChannel(send)]])]]),
    });

    await runFeedPass(deps, false);

    expect(send).not.toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledTimes(1);
  });

  it('keeps polling other guilds when one guild’s repos lookup throws', async () => {
    const send = makeSend();
    const healthy = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })]);
    const { deps, errorLog } = harness({
      posts: [post({ id: '10' })],
      guilds: new Map([
        ['g-broken', healthy.repos],
        ['g-healthy', healthy.repos],
      ]),
      guildChannels: new Map([['g-healthy', new Map([[CHANNEL, makeChannel(send)]])]]),
      throwForGuild: 'g-broken',
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('keeps polling later groups when one platform read rejects', async () => {
    // A platform promises to put every failure on the Err rail, but it
    // is an injected seam: one that rejects must cost its own group only.
    const send = makeSend();
    const first = subscription({ account: 'aaa', last_seen_id: '5', last_seen_timestamp: 50 });
    const second = subscription({ account: 'bbb', last_seen_id: '5', last_seen_timestamp: 50 });
    const { repos } = makeRepos([first, second]);
    const { deps, fetchTimeline, errorLog } = harness({
      posts: [post({ id: '10', authorAccount: 'bbb' })],
      repos,
      channel: makeChannel(send),
    });
    fetchTimeline.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('names the affected guilds when a shared upstream read fails', async () => {
    // The read serves several guilds at once, so the error carries no
    // single guild id; without this binding an operator could not tell
    // whose feed went quiet.
    const a = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })]);
    const b = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })]);
    const { deps, logBindings } = harness({
      fetchFails: true,
      guilds: new Map([
        ['g-a', a.repos],
        ['g-b', b.repos],
      ]),
    });

    await runFeedPass(deps, false);

    expect(logBindings).toContainEqual({ plugin: 'social-feed', guildIds: ['g-a', 'g-b'] });
  });

  it('survives a cursor write failure after a successful send', async () => {
    const send = makeSend();
    const { repos } = makeRepos([subscription({ last_seen_id: '5', last_seen_timestamp: 50 })], {
      advanceFails: true,
    });
    const { deps, errorLog } = harness({
      posts: [post({ id: '10' })],
      repos,
      channel: makeChannel(send),
    });

    await expect(runFeedPass(deps, false)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
