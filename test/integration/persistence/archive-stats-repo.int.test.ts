/**
 * `ArchiveStatsRepo` against a real MongoDB: every counting rule, the channel
 * attribution rule, reply/mention partners, retention, active days across a time
 * zone boundary, hot messages, reactions given, interaction records, emoji and
 * sticker usage by ID, the query-timeout mapping, index use of each pipeline, and
 * read access for a bot that does not own the archive.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ArchiveChannelInfo, StatsWindow } from '../../../src/core/archive/stats';
import type { ArchiveMessage } from '../../../src/core/archive/types';
import { asGuildId } from '../../../src/core/ids';
import { map, unwrap } from '../../../src/core/result';
import {
  StaticConnectionManager,
  type GuildConnection,
} from '../../../src/infra/mongo/connection-manager';
import { buildRepos } from '../../../src/persistence/repositories';
import {
  activityPipeline,
  appUsagePipeline,
  emojiUsagePipeline,
  reactionsGivenPipeline,
  scanIndexHint,
  snowflakeAt,
  stickerUsagePipeline,
  type Stage,
} from '../../../src/persistence/repositories/archive-stats.pipelines';
import { MongoArchiveRepo } from '../../../src/persistence/repositories/archive.repo';
import { MongoArchiveStatsRepo } from '../../../src/persistence/repositories/archive-stats.repo';
import { planActivity } from '../../../src/persistence/repositories/archive-stats.report';
import type { ArchiveStatsScope } from '../../../src/persistence/repositories/archive-stats.types';
import type { ArchiveReactionDoc } from '../../../src/persistence/schemas/archive.schema';
import { withFreshConnection } from '../helpers/mongo';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 2026-01-05 00:00 UTC. */
const T0 = Date.UTC(2026, 0, 5);
const WEEK: StatsWindow = { startMs: T0, endMs: T0 + 7 * DAY };
const PREVIOUS_WEEK: StatsWindow = { startMs: T0 - 7 * DAY, endMs: T0 };
const VISIBLE = ['text', 'text-thread', 'forum-post', 'forum-post-2', 'gone', 'other'];
const scope = { channelIds: VISIBLE };

let sequence = 0;
type Seed = Partial<ArchiveMessage> & { readonly at?: number };
/** A schema 3 message whose snowflake matches its creation time. */
const message = ({ at = T0 + HOUR, ...fields }: Seed): ArchiveMessage => ({
  _id: (snowflakeAt(at) + BigInt(sequence++)).toString(),
  schemaVersion: 3,
  channelId: 'text',
  author: { id: 'u1', username: 'one' },
  type: 0,
  content: 'hello',
  createdTimestamp: at,
  observedAt: at,
  ...fields,
});

const CHANNELS: ArchiveChannelInfo[] = [
  { channelId: 'text', name: 'general', type: 0, access: 'readable', everyoneCanView: true },
  { channelId: 'text-thread', name: 'side', type: 11, parentId: 'text', access: 'readable' },
  { channelId: 'forum', name: 'questions', type: 15, access: 'readable' },
  { channelId: 'forum-post', name: 'How do I?', type: 11, parentId: 'forum', access: 'readable' },
  { channelId: 'forum-post-2', name: 'Why?', type: 11, parentId: 'forum', access: 'readable' },
  { channelId: 'gone', name: 'old-room', type: 0, access: 'deleted', everyoneCanView: true },
  { channelId: 'other', name: 'other', type: 0, access: 'readable' },
  { channelId: 'hidden', name: 'staff', type: 0, access: 'readable' },
];

interface Fixture {
  readonly connection: Connection;
  readonly guild: GuildConnection;
  readonly repo: MongoArchiveStatsRepo;
}
const withFixture = (
  seed: { messages?: readonly ArchiveMessage[]; reactions?: readonly ArchiveReactionDoc[] },
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> =>
  withFreshConnection(async (connection) => {
    const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
    await connection.collection('archive_channels').insertMany(CHANNELS.map((c) => ({ ...c })));
    if (seed.messages?.length)
      await connection
        .collection<ArchiveMessage>('messages')
        .insertMany(seed.messages.map((m) => ({ ...m })));
    if (seed.reactions?.length)
      await connection
        .collection<ArchiveReactionDoc>('archive_reactions')
        .insertMany(seed.reactions.map((r) => ({ ...r })));
    await body({ connection, guild, repo: new MongoArchiveStatsRepo(guild) });
  });

/**
 * One `activity()` section run alone, so each rule is checked through the method
 * the commands call; the composite test compares these with one combined scan.
 */
type Filter = ArchiveStatsScope & { readonly authorId?: string };
const byAuthor = (filter: Filter): { authorId?: string } =>
  filter.authorId === undefined ? {} : { authorId: filter.authorId };
const only = (filter: Filter): ArchiveStatsScope => ({ channelIds: filter.channelIds });
const summaryOf = async (repo: MongoArchiveStatsRepo, window: StatsWindow, filter: Filter) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { summary: byAuthor(filter) },
    }),
    (report) => report.summary,
  );
const channelsOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  filter: Filter,
  options: { readonly fold?: boolean; readonly limit?: number } = {},
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { channels: { ...options, ...byAuthor(filter) } },
    }),
    (report) => report.channels,
  );
const authorsOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  filter: Filter,
  options: { readonly limit?: number; readonly rankOf?: string } = {},
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { authors: options },
    }),
    (report) => report.authors,
  );
const trendOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  granularity: 'hour' | 'day' | 'week',
  filter: Filter,
  timeZone: string,
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone,
      sections: { trend: { granularity, ...byAuthor(filter) } },
    }),
    (report) => report.trend.current,
  );
const heatmapOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  filter: Filter,
  timeZone: string,
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone,
      sections: { heatmap: byAuthor(filter) },
    }),
    (report) => report.heatmap,
  );
const reactionsOf = async (repo: MongoArchiveStatsRepo, window: StatsWindow, filter: Filter) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { reactions: byAuthor(filter) },
    }),
    (report) => report.reactions,
  );
const partnersOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  userId: string,
  filter: Filter,
  options: { readonly limit?: number; readonly excludeUserIds?: readonly string[] } = {},
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { partners: { userId, ...options } },
    }),
    (report) => report.partners,
  );
const retentionOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  previousWindow: StatsWindow,
  filter: Filter,
) =>
  map(
    await repo.activity({
      window,
      previousWindow,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { retention: {} },
    }),
    (report) => report.retention,
  );
const activeDaysOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  userId: string,
  filter: Filter,
  timeZone: string,
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone,
      sections: { activeDays: { userId } },
    }),
    (report) => report.activeDays,
  );
const topMessagesOf = async (
  repo: MongoArchiveStatsRepo,
  window: StatsWindow,
  filter: Filter,
  limit: number,
) =>
  map(
    await repo.activity({
      window,
      scope: only(filter),
      timeZone: 'UTC',
      sections: { topMessages: { limit } },
    }),
    (report) => report.topMessages,
  );

describe('ArchiveStatsRepo counting rules', () => {
  it('counts deleted messages but skips bots, webhooks, system messages, tombstones and hidden channels', async () => {
    const messages = [
      message({}),
      message({ author: { id: 'u2' }, deletedAt: T0 + 2 * HOUR }),
      message({ author: { id: 'u3' }, type: 19, reference: { authorId: 'u1', messageId: '1' } }),
      message({ author: { id: 'bot', bot: true } }),
      message({ author: { id: 'hook' }, webhookId: 'w1' }),
      message({ author: { id: 'u4' }, type: 7 }),
      message({
        author: { id: 'app', bot: true },
        type: 20,
        interactionMetadata: { id: 'i1', type: 2, user: { id: 'u1' } },
      }),
      // A tombstone carries no author; an unresolved identity carries no type either.
      { ...message({}), author: undefined, deletedAt: T0 },
      { ...message({}), author: undefined, type: undefined },
      message({ author: { id: 'u5' }, channelId: 'hidden' }),
      message({ author: { id: 'u6' }, at: WEEK.endMs }),
      message({ author: { id: 'u7' }, at: WEEK.startMs - 1 }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const summary = unwrap(await summaryOf(repo, WEEK, scope));
      expect(summary.messages).toBe(3);
      expect(summary.activeMembers).toBe(3);
      expect(summary.content.replies).toBe(1);
      const own = unwrap(await summaryOf(repo, WEEK, { ...scope, authorId: 'u2' }));
      expect(own.messages).toBe(1);
      expect(unwrap(await summaryOf(repo, WEEK, { channelIds: [] })).messages).toBe(0);
    });
  });

  it('classifies content per message, allowing several categories at once', async () => {
    const voiceFlag = 8192;
    const messages = [
      message({
        attachments: [{ contentType: 'image/png' }, { contentType: 'application/pdf' }],
        content: 'see https://example.com',
      }),
      message({ attachments: [{ contentType: 'video/mp4' }] }),
      message({ attachments: [{ name: 'notes.txt' }] }),
      message({ attachments: [{ contentType: 'audio/ogg' }], flags: voiceFlag }),
      message({ content: 'HTTP://LOUD.example' }),
      message({ stickers: [{ id: 's1' }] }),
      message({ stickers: [] }),
      message({ poll: { question: { text: 'Lunch?' } } }),
      message({ poll: null }),
      message({ reference: { type: 1, messageId: 'x' } }),
      message({ type: 19, reference: { type: 0, authorId: 'u2' } }),
      message({ editedTimestamp: T0 + 3 * HOUR }),
      message({ editedTimestamp: null }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const summary = unwrap(await summaryOf(repo, WEEK, scope));
      expect(summary.content).toEqual({
        media: 2,
        files: 2,
        voice: 1,
        links: 2,
        stickers: 1,
        polls: 1,
        forwards: 1,
        replies: 1,
      });
      expect(summary.edited).toBe(1);
      expect(summary.messages).toBe(13);
    });
  });
});

describe('ArchiveStatsRepo channel attribution', () => {
  it('folds text threads into the channel and keeps forum posts standalone with the forum name', async () => {
    const messages = [
      ...Array.from({ length: 3 }, () => message({ channelId: 'text' })),
      ...Array.from({ length: 2 }, () => message({ channelId: 'text-thread' })),
      ...Array.from({ length: 4 }, () => message({ channelId: 'forum-post' })),
      message({ channelId: 'forum-post-2' }),
      ...Array.from({ length: 2 }, () => message({ channelId: 'gone' })),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const folded = unwrap(await channelsOf(repo, WEEK, scope));
      expect(folded.rows).toEqual([
        { channelId: 'text', messages: 5, name: 'general', type: 0, deleted: false },
        {
          channelId: 'forum-post',
          messages: 4,
          name: 'How do I?',
          type: 11,
          deleted: false,
          forum: { channelId: 'forum', name: 'questions' },
        },
        { channelId: 'gone', messages: 2, name: 'old-room', type: 0, deleted: true },
        {
          channelId: 'forum-post-2',
          messages: 1,
          name: 'Why?',
          type: 11,
          deleted: false,
          forum: { channelId: 'forum', name: 'questions' },
        },
      ]);
      expect(folded.distinct).toBe(4);
      expect(folded.total).toBe(12);

      const raw = unwrap(await channelsOf(repo, WEEK, scope, { fold: false, limit: 2 }));
      expect(raw.rows.map((row) => [row.channelId, row.messages])).toEqual([
        ['forum-post', 4],
        ['text', 3],
      ]);
      expect(raw.distinct).toBe(5);

      expect(unwrap(await summaryOf(repo, WEEK, scope)).activeChannels).toBe(4);
    });
  });
});

describe('ArchiveStatsRepo rankings and trends', () => {
  it('ranks authors with their newest names and the subject rank', async () => {
    const messages = [
      message({ author: { id: 'a', username: 'old-a' }, at: T0 + HOUR }),
      message({ author: { id: 'a', username: 'new-a', globalName: 'A' }, at: T0 + 2 * HOUR }),
      message({ author: { id: 'a', username: 'old-a' }, at: T0 + 30 * 60_000 }),
      message({ author: { id: 'b' } }),
      message({ author: { id: 'b' } }),
      message({ author: { id: 'c' } }),
      message({ author: { id: 'd' } }),
      message({ author: { id: 'd' } }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const ranking = unwrap(await authorsOf(repo, WEEK, scope, { limit: 2, rankOf: 'd' }));
      expect(ranking.rows).toEqual([
        { userId: 'a', messages: 3, username: 'new-a', globalName: 'A' },
        { userId: 'b', messages: 2 },
      ]);
      expect(ranking.distinct).toBe(4);
      expect(ranking.total).toBe(8);
      expect(ranking.subject).toEqual({ userId: 'd', rank: 2, messages: 2 });
      const absent = unwrap(await authorsOf(repo, WEEK, scope, { rankOf: 'nobody' }));
      expect(absent.subject).toEqual({ userId: 'nobody', rank: null, messages: 0 });
    });
  });

  it('buckets trends and heat maps in the requested time zone with zero-filled gaps', async () => {
    // 2026-01-05 23:30 UTC is Tuesday 07:30 in Taipei.
    const late = T0 + 23 * HOUR + 30 * 60_000;
    const messages = [
      message({ at: late }),
      message({ at: T0 + 2 * DAY + HOUR }),
      message({ at: T0 - 2 * DAY }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const utc = unwrap(await trendOf(repo, WEEK, 'day', scope, 'UTC'));
      expect(utc).toHaveLength(7);
      expect(utc.slice(0, 3)).toEqual([
        { key: '2026-01-05', messages: 1 },
        { key: '2026-01-06', messages: 0 },
        { key: '2026-01-07', messages: 1 },
      ]);
      const taipei = unwrap(await trendOf(repo, WEEK, 'day', scope, 'Asia/Taipei'));
      expect(taipei[0]).toEqual({ key: '2026-01-05', messages: 0 });
      expect(taipei[1]).toEqual({ key: '2026-01-06', messages: 1 });

      const heat = unwrap(await heatmapOf(repo, WEEK, scope, 'Asia/Taipei'));
      expect(heat.cells).toHaveLength(7);
      expect(heat.cells[1]?.[7]).toBe(1);
      expect(heat.cells[0]?.[23]).toBe(0);
      expect(unwrap(await heatmapOf(repo, WEEK, scope, 'UTC')).cells[0]?.[23]).toBe(1);

      const report = unwrap(
        await repo.activity({
          window: WEEK,
          previousWindow: PREVIOUS_WEEK,
          scope,
          timeZone: 'UTC',
          sections: { summary: {}, trend: { granularity: 'week' } },
        }),
      );
      expect(report.summary.previousMessages).toBe(1);
      expect(report.trend.current).toEqual([{ key: '2026-01-05', messages: 2 }]);
      expect(report.trend.previous).toEqual([{ key: '2025-12-29', messages: 1 }]);
    });
  });

  it('splits a quarter hour that straddles an unaligned window start between the windows', async () => {
    const start = T0 + 7 * 60_000;
    const window = { startMs: start, endMs: start + 2 * DAY };
    const previousWindow = { startMs: start - 2 * DAY, endMs: start };
    const messages = [
      message({ author: { id: 'a' }, at: T0 + 3 * 60_000 }),
      message({ author: { id: 'a' }, at: T0 + 10 * 60_000 }),
      message({ author: { id: 'a' }, at: T0 + 12 * 60_000 }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const report = unwrap(
        await repo.activity({
          window,
          previousWindow,
          scope,
          timeZone: 'UTC',
          sections: {
            trend: { granularity: 'hour' },
            heatmap: {},
            activeDays: { userId: 'a' },
          },
        }),
      );
      expect(report.trend.current[0]).toEqual({ key: '2026-01-05T00', messages: 2 });
      expect(report.trend.previous?.at(-1)).toEqual({ key: '2026-01-05T00', messages: 1 });
      expect(report.heatmap.cells[0]?.[0]).toBe(2);
      expect(report.activeDays.dayKeys).toEqual(['2026-01-05']);
    });
  });

  it('computes the composite report identically to each section run alone', async () => {
    const messages = [
      message({ author: { id: 'a' }, reactions: [{ emoji: { name: '👍' }, count: 2 }] }),
      message({ author: { id: 'b' }, channelId: 'text-thread' }),
      message({ author: { id: 'a' }, at: T0 - DAY }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const report = unwrap(
        await repo.activity({
          window: WEEK,
          previousWindow: PREVIOUS_WEEK,
          scope,
          timeZone: 'Asia/Taipei',
          sections: {
            summary: {},
            channels: {},
            authors: { rankOf: 'a' },
            reactions: {},
            retention: {},
            heatmap: {},
          },
        }),
      );
      const { previousMessages, ...current } = report.summary;
      expect(previousMessages).toBe(1);
      expect(current).toEqual(unwrap(await summaryOf(repo, WEEK, scope)));
      expect(report.channels).toEqual(unwrap(await channelsOf(repo, WEEK, scope)));
      expect(report.authors).toEqual(unwrap(await authorsOf(repo, WEEK, scope, { rankOf: 'a' })));
      expect(report.reactions).toEqual(unwrap(await reactionsOf(repo, WEEK, scope)));
      expect(report.retention).toEqual(unwrap(await retentionOf(repo, WEEK, PREVIOUS_WEEK, scope)));
      expect(report.heatmap).toEqual(unwrap(await heatmapOf(repo, WEEK, scope, 'Asia/Taipei')));
    });
  });

  it('summarizes reactions received by an author', async () => {
    const messages = [
      message({
        author: { id: 'a' },
        reactions: [
          { emoji: { id: 'e1', name: 'party', animated: true }, count: 3 },
          { emoji: { name: '👍' }, count: 1 },
        ],
      }),
      message({ author: { id: 'a' }, reactions: [{ emoji: { name: '👍' }, count: 4 }] }),
      message({ author: { id: 'b' }, reactions: [{ emoji: { name: '👍' }, count: 9 }] }),
      message({ author: { id: 'a' }, reactions: [] }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const received = unwrap(await reactionsOf(repo, WEEK, { ...scope, authorId: 'a' }));
      expect(received).toEqual({
        total: 8,
        top: [
          { key: '👍', name: '👍', count: 5 },
          { key: 'e1', emojiId: 'e1', name: 'party', animated: true, count: 3 },
        ],
      });
    });
  });
});

describe('ArchiveStatsRepo member interactions', () => {
  it('sums the four reply and mention directions without double-counting reply mentions', async () => {
    const botMessage = message({
      author: { id: 'helper-bot', bot: true },
      mentions: { users: ['me'] },
    });
    const messages = [
      // u2 replies to me with the automatic mention: one reply, no mention.
      message({
        author: { id: 'u2' },
        type: 19,
        reference: { authorId: 'me' },
        mentions: { users: ['me'] },
      }),
      // u2 mentions me without replying.
      message({ author: { id: 'u2' }, mentions: { users: ['me', 'u9'] } }),
      // I reply to u3 (auto mention) and also mention u4 and myself.
      message({
        author: { id: 'me' },
        type: 19,
        reference: { authorId: 'u3' },
        mentions: { users: ['u3', 'u4', 'me'] },
      }),
      // I reply to my own message and mention a bot the caller excludes.
      message({
        author: { id: 'me' },
        type: 19,
        reference: { authorId: 'me' },
        mentions: { users: ['helper-bot'] },
      }),
      // I reply to a bot's message: the stored reply target reveals the bot.
      message({
        author: { id: 'me' },
        type: 19,
        reference: { authorId: 'helper-bot', messageId: botMessage._id },
      }),
      // A bot mentioning me and a hidden-channel mention never count.
      botMessage,
      message({ author: { id: 'u5' }, channelId: 'hidden', mentions: { users: ['me'] } }),
      // A forward's reference is not a reply.
      message({ author: { id: 'u6' }, reference: { type: 1, authorId: 'me' } }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const result = unwrap(
        await partnersOf(repo, WEEK, 'me', scope, { excludeUserIds: ['helper-bot'] }),
      );
      expect(result.partners).toEqual([
        { userId: 'u2', repliesTo: 0, repliesFrom: 1, mentionsTo: 0, mentionsFrom: 1, total: 2 },
        { userId: 'u3', repliesTo: 1, repliesFrom: 0, mentionsTo: 0, mentionsFrom: 0, total: 1 },
        { userId: 'u4', repliesTo: 0, repliesFrom: 0, mentionsTo: 1, mentionsFrom: 0, total: 1 },
      ]);
      expect(result.totals).toEqual({
        repliesSent: 1,
        repliesReceived: 1,
        mentionsSent: 1,
        mentionsReceived: 1,
      });
      expect(
        unwrap(await partnersOf(repo, WEEK, 'me', scope, { limit: 1 })).totals.mentionsReceived,
      ).toBe(1);
      // Without the caller's exclusion the reply to the bot's message still excludes it.
      const unaided = unwrap(await partnersOf(repo, WEEK, 'me', scope));
      expect(unaided.partners.map((partner) => partner.userId)).toEqual(['u2', 'u3', 'u4']);
      expect(unaided.totals).toEqual(result.totals);
    });
  });

  it('measures retention and returning or new members against the previous window', async () => {
    const messages = [
      ...['a', 'b', 'c'].map((id) => message({ author: { id }, at: T0 - DAY })),
      ...['b', 'c', 'd', 'e'].map((id) => message({ author: { id } })),
      message({ author: { id: 'f' }, channelId: 'hidden', at: T0 - DAY }),
      message({ author: { id: 'f' }, channelId: 'hidden' }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      expect(unwrap(await retentionOf(repo, WEEK, PREVIOUS_WEEK, scope))).toEqual({
        previousMembers: 3,
        currentMembers: 4,
        retained: 2,
        returningOrNew: 2,
        retentionRate: 2 / 3,
      });
      const empty = unwrap(
        await retentionOf(repo, WEEK, { startMs: T0 - 30 * DAY, endMs: T0 - 20 * DAY }, scope),
      );
      expect(empty.retentionRate).toBeNull();
      expect(empty.returningOrNew).toBe(4);
    });
  });

  it('counts active days and the longest streak in the requested time zone', async () => {
    // 15:30 and 16:30 UTC fall on one UTC day but straddle midnight in Taipei (UTC+8).
    const messages = [
      message({ author: { id: 'me' }, at: T0 + 15 * HOUR + 30 * 60_000 }),
      message({ author: { id: 'me' }, at: T0 + 16 * HOUR + 30 * 60_000 }),
      message({ author: { id: 'me' }, at: T0 + DAY + 20 * HOUR }),
      message({ author: { id: 'me' }, at: T0 + 4 * DAY + HOUR }),
      message({ author: { id: 'other' }, at: T0 + 3 * DAY }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      expect(unwrap(await activeDaysOf(repo, WEEK, 'me', scope, 'UTC'))).toEqual({
        activeDays: 3,
        longestStreak: 2,
        dayKeys: ['2026-01-05', '2026-01-06', '2026-01-09'],
      });
      expect(unwrap(await activeDaysOf(repo, WEEK, 'me', scope, 'Asia/Taipei'))).toEqual({
        activeDays: 4,
        longestStreak: 3,
        dayKeys: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-09'],
      });
    });
  });
});

describe('ArchiveStatsRepo hot messages', () => {
  it('orders live member messages by reaction total and returns the preview fields', async () => {
    const reactions = (count: number) => [{ emoji: { name: '👍' }, count }];
    const top = message({
      author: { id: 'a', username: 'alice', globalName: 'Alice' },
      at: T0 + 5 * HOUR,
      content: 'big news',
      editedTimestamp: T0 + 6 * HOUR,
      attachments: [{ contentType: 'image/png', name: 'a.png', url: 'https://cdn/a.png' }],
      stickers: [{ id: 's1', name: 'wave', format: 1 }],
      reactions: [
        { emoji: { name: '👍' }, count: 3 },
        { emoji: { id: 'e1', name: 'party' }, count: 7 },
      ],
    });
    const tieEarly = message({ author: { id: 'b' }, at: T0 + HOUR, reactions: reactions(5) });
    const tieLate = message({ author: { id: 'c' }, at: T0 + 2 * HOUR, reactions: reactions(5) });
    const messages = [
      top,
      tieLate,
      tieEarly,
      message({ author: { id: 'd' }, reactions: reactions(50), deletedAt: T0 + 9 * HOUR }),
      message({ author: { id: 'bot', bot: true }, reactions: reactions(60) }),
      message({ author: { id: 'hook' }, webhookId: 'w', reactions: reactions(70) }),
      message({ author: { id: 'e' }, channelId: 'hidden', reactions: reactions(80) }),
      message({ author: { id: 'f' }, reactions: [{ emoji: { name: '👀' }, count: 0 }] }),
      message({
        author: { id: 'g' },
        content: '',
        reference: { type: 1 },
        messageSnapshots: [{ content: 'forwarded text' }],
        poll: { question: { text: 'Pick one' } },
        reactions: reactions(1),
      }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const hot = unwrap(await topMessagesOf(repo, WEEK, scope, 3));
      expect(hot.map((entry) => entry.messageId)).toEqual([top._id, tieEarly._id, tieLate._id]);
      expect(hot[0]).toEqual({
        messageId: top._id,
        channelId: 'text',
        createdTimestamp: T0 + 5 * HOUR,
        author: { id: 'a', username: 'alice', globalName: 'Alice' },
        content: 'big news',
        edited: true,
        attachments: [{ contentType: 'image/png', name: 'a.png' }],
        stickers: [{ id: 's1', name: 'wave' }],
        totalReactions: 10,
        reactions: [
          { key: 'e1', emojiId: 'e1', name: 'party', count: 7 },
          { key: '👍', name: '👍', count: 3 },
        ],
      });
      const all = unwrap(await topMessagesOf(repo, WEEK, scope, 10));
      expect(all).toHaveLength(4);
      expect(all[3]).toMatchObject({
        pollQuestion: 'Pick one',
        forwardedContent: 'forwarded text',
      });
      expect(all[3]?.content).toBeUndefined();
    });
  });
});

describe('ArchiveStatsRepo reactions given', () => {
  const chunk = (
    target: ArchiveMessage,
    emojiKey: string,
    fields: Partial<ArchiveReactionDoc> = {},
  ): ArchiveReactionDoc => ({
    messageId: target._id,
    channelId: target.channelId,
    emojiKey,
    type: 0,
    generation: 'g1',
    chunk: 0,
    userIds: ['me', 'someone'],
    observedAt: target.createdTimestamp,
    ...fields,
  });
  const published = (keys: readonly string[]) =>
    Object.fromEntries(
      keys.map((key) => [key, { generation: 'g1', observedAt: T0, complete: true }]),
    );

  it('counts published membership on visible, in-window messages of other members', async () => {
    const visible = message({
      author: { id: 'u2' },
      reactions: [{ emoji: { id: 'e1', name: 'party' }, count: 2 }],
      reactionGenerations: published(['e1:0', '👍:0', '👍:1']),
    });
    const second = message({
      author: { id: 'u3' },
      at: T0 + 3 * DAY,
      reactionGenerations: published(['👍:0']),
    });
    const hidden = message({
      author: { id: 'u2' },
      channelId: 'hidden',
      reactionGenerations: published(['👍:0']),
    });
    const own = message({ author: { id: 'me' }, reactionGenerations: published(['👍:0']) });
    const old = message({
      author: { id: 'u2' },
      at: T0 - DAY,
      reactionGenerations: published(['👍:0']),
    });
    // Reactions on a bot's or a system message are not member activity.
    const fromBot = message({
      author: { id: 'helper-bot', bot: true },
      reactionGenerations: published(['👍:0']),
    });
    const system = message({
      author: { id: 'u2' },
      type: 7,
      reactionGenerations: published(['👍:0']),
    });
    const reactions = [
      chunk(visible, 'e1'),
      chunk(visible, '👍'),
      chunk(visible, '👍', { type: 1 }),
      // A superseded generation awaiting garbage collection.
      chunk(visible, '👍', { generation: 'g0' }),
      chunk(second, '👍'),
      chunk(second, '👍', { chunk: 1, userIds: ['someone-else'] }),
      chunk(hidden, '👍'),
      chunk(own, '👍'),
      chunk(old, '👍'),
      chunk(fromBot, '👍'),
      chunk(system, '👍'),
    ];
    await withFixture(
      { messages: [visible, second, hidden, own, old, fromBot, system], reactions },
      async ({ repo }) => {
        expect(unwrap(await repo.reactionsGiven(WEEK, 'me', scope))).toEqual({
          total: 4,
          byEmoji: [
            { key: '👍', count: 3 },
            { key: 'e1', emojiId: 'e1', name: 'party', count: 1 },
          ],
        });
        const narrow = unwrap(await repo.reactionsGiven(WEEK, 'me', { channelIds: ['other'] }));
        expect(narrow).toEqual({ total: 0, byEmoji: [] });
      },
    );
  });
});

describe('ArchiveStatsRepo application usage', () => {
  const record = (
    applicationId: string | undefined,
    interaction: { id: string; type: number; user: string; userBot?: boolean },
    fields: Seed = {},
  ): ArchiveMessage =>
    message({
      author: {
        id: `bot-${applicationId ?? 'none'}`,
        username: `${applicationId ?? 'none'}-bot`,
        bot: true,
      },
      ...(applicationId === undefined ? {} : { applicationId }),
      type: interaction.type === 2 ? 20 : 19,
      content: undefined,
      interactionMetadata: {
        id: interaction.id,
        type: interaction.type,
        user: { id: interaction.user, ...(interaction.userBot ? { bot: true } : {}) },
      },
      ...fields,
    });

  it('counts interaction records only, per application and interaction type', async () => {
    const messages = [
      record('app1', { id: 'i1', type: 2, user: 'u1' }),
      // A follow-up shares the interaction ID and counts once.
      record('app1', { id: 'i1', type: 2, user: 'u1' }, { at: T0 + 2 * HOUR }),
      record('app1', { id: 'i2', type: 3, user: 'u2' }),
      record('app1', { id: 'i3', type: 5, user: 'u1' }),
      record('app2', { id: 'i4', type: 2, user: 'u2' }, { at: T0 + 2 * DAY }),
      record('app2', { id: 'i5', type: 2, user: 'other-bot', userBot: true }),
      record(undefined, { id: 'i6', type: 2, user: 'u3' }),
      record('app1', { id: 'i7', type: 2, user: 'u1' }, { channelId: 'hidden' }),
      // Not interaction records: a human message and a plain bot message.
      message({ author: { id: 'u1' } }),
      message({ author: { id: 'bot-app1', bot: true }, applicationId: 'app1' }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      const usage = unwrap(
        await repo.appUsage(WEEK, scope, {
          trend: { granularity: 'day', timeZone: 'UTC' },
          heatmap: { timeZone: 'UTC' },
        }),
      );
      expect(usage.uses).toBe(6);
      // A bot that triggers an interaction is never counted as a member.
      expect(usage.users).toBe(3);
      expect(usage.firstRecordAt).toBe(T0 + HOUR);
      expect(usage.apps).toEqual([
        {
          applicationId: 'app1',
          username: 'app1-bot',
          uses: 3,
          commands: 1,
          components: 1,
          modals: 1,
          users: 2,
        },
        {
          applicationId: 'app2',
          username: 'app2-bot',
          uses: 2,
          commands: 2,
          components: 0,
          modals: 0,
          users: 1,
        },
        {
          applicationId: 'bot-none',
          username: 'none-bot',
          uses: 1,
          commands: 1,
          components: 0,
          modals: 0,
          users: 1,
        },
      ]);
      // Member rankings never include bots.
      expect(usage.topUsers).toEqual([
        { userId: 'u1', uses: 2 },
        { userId: 'u2', uses: 2 },
        { userId: 'u3', uses: 1 },
      ]);
      expect(usage.trend?.slice(0, 3)).toEqual([
        { key: '2026-01-05', uses: 5 },
        { key: '2026-01-06', uses: 0 },
        { key: '2026-01-07', uses: 1 },
      ]);
      expect(usage.heatmap?.cells[0]?.[1]).toBe(5);
      expect(usage.heatmap?.cells[2]?.[0]).toBe(1);

      const one = unwrap(await repo.appUsage(WEEK, scope, { applicationId: 'app2' }));
      expect(one.apps.map((app) => app.applicationId)).toEqual(['app2']);
      const byMember = unwrap(await repo.appUsage(WEEK, scope, { userId: 'u1' }));
      expect(byMember.uses).toBe(2);
      expect(byMember.trend).toBeUndefined();
      expect(byMember.heatmap).toBeUndefined();
    });
  });
});

describe('ArchiveStatsRepo emoji and sticker usage', () => {
  it('counts custom emoji by ID across renames and every channel, listing zero counts', async () => {
    const messages = [
      message({ content: '<:old_name:111> and <:new_name:111> <a:dance:222>' }),
      message({ channelId: 'hidden', content: 'staff <:new_name:111>' }),
      message({
        reactions: [
          {
            emoji: { id: '111', name: 'new_name' },
            count: 3,
            countDetails: { normal: 2, burst: 1 },
          },
          { emoji: { id: '999', name: 'foreign' }, count: 4 },
        ],
      }),
      message({
        channelId: 'hidden',
        reactions: [{ emoji: { id: '222', name: 'dance' }, count: 2 }],
      }),
      message({ author: { id: 'bot', bot: true }, content: '<:new_name:111>' }),
      message({ content: '<:new_name:111>', at: T0 - DAY }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      expect(unwrap(await repo.emojiUsage(WEEK, ['111', '222', '333']))).toEqual([
        { emojiId: '111', messageUses: 3, reactionUses: 3 },
        { emojiId: '222', messageUses: 1, reactionUses: 2 },
        { emojiId: '333', messageUses: 0, reactionUses: 0 },
      ]);
      expect(unwrap(await repo.emojiUsage(WEEK, []))).toEqual([]);
    });
  });

  it('counts stickers by ID across renames and every channel, listing zero counts', async () => {
    const messages = [
      message({ stickers: [{ id: 's1', name: 'old' }] }),
      message({ channelId: 'hidden', stickers: [{ id: 's1', name: 'renamed' }, { id: 's2' }] }),
      message({ author: { id: 'bot', bot: true }, stickers: [{ id: 's1' }] }),
    ];
    await withFixture({ messages }, async ({ repo }) => {
      expect(unwrap(await repo.stickerUsage(WEEK, ['s1', 's2', 's3']))).toEqual([
        { stickerId: 's1', uses: 2 },
        { stickerId: 's2', uses: 1 },
        { stickerId: 's3', uses: 0 },
      ]);
    });
  });
});

describe('ArchiveStatsRepo index use', () => {
  const stagesOf = (node: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const child of node) stagesOf(child, acc);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'stage' && typeof value === 'string') acc.push(value);
        else stagesOf(value, acc);
      }
    }
    return acc;
  };
  const explainStages = async (
    connection: Connection,
    collection: string,
    pipeline: Stage[],
  ): Promise<string[]> =>
    stagesOf(await connection.collection(collection).aggregate(pipeline).explain('queryPlanner'));

  it('starts every main pipeline with an index scan, never a collection scan', async () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message({ author: { id: `u${index % 5}` }, at: T0 + index * HOUR }),
    );
    await withFixture({ messages }, async ({ connection }) => {
      const pipelines: [string, Stage[]][] = [
        [
          'messages',
          activityPipeline(
            VISIBLE,
            planActivity({
              window: WEEK,
              previousWindow: PREVIOUS_WEEK,
              scope,
              timeZone: 'UTC',
              sections: {
                summary: {},
                trend: { granularity: 'day' },
                heatmap: { authorId: 'u2' },
                channels: { authorId: 'u3' },
                authors: { rankOf: 'u1' },
                reactions: {},
                retention: {},
                activeDays: { userId: 'u1' },
                partners: { userId: 'u1' },
                topMessages: { limit: 3 },
              },
            }),
          ),
        ],
        ['messages', appUsagePipeline(WEEK, VISIBLE, { limit: 10 })],
        ['messages', emojiUsagePipeline(WEEK, ['111'])],
        ['messages', stickerUsagePipeline(WEEK, ['s1'])],
        ['archive_reactions', reactionsGivenPipeline(WEEK, 'u1', VISIBLE)],
      ];
      for (const [collection, pipeline] of pipelines) {
        const stages = await explainStages(connection, collection, pipeline);
        expect(stages, collection).toContain('IXSCAN');
        expect(stages, collection).not.toContain('COLLSCAN');
      }
    });
  });

  it('scans wide scopes by time and narrow scopes through the channel index', async () => {
    expect(scanIndexHint(400, 1_000)).toEqual({ createdTimestamp: 1 });
    expect(scanIndexHint(250, 1_000)).toEqual({ channelId: 1, createdTimestamp: 1 });
    expect(scanIndexHint(1, 0)).toEqual({ createdTimestamp: 1 });
    const messages = Array.from({ length: 20 }, (_, index) =>
      message({ channelId: index % 2 === 0 ? 'text' : 'other', at: T0 + index * HOUR }),
    );
    await withFixture({ messages }, async ({ connection, guild, repo }) => {
      const aggregate = vi.spyOn(guild.models.Message.collection, 'aggregate');
      try {
        // 6 of 8 recorded channels: wide. 1 of 8: narrow.
        unwrap(await summaryOf(repo, WEEK, scope));
        unwrap(await summaryOf(repo, WEEK, { channelIds: ['text'] }));
        expect(aggregate.mock.calls.map(([, options]) => options?.hint)).toEqual([
          { createdTimestamp: 1 },
          { channelId: 1, createdTimestamp: 1 },
        ]);
      } finally {
        aggregate.mockRestore();
      }
      const narrow = await connection
        .collection('messages')
        .aggregate(
          activityPipeline(
            ['text'],
            planActivity({ window: WEEK, scope, timeZone: 'UTC', sections: { summary: {} } }),
          ),
          { hint: { channelId: 1, createdTimestamp: 1 } },
        )
        .explain('queryPlanner');
      expect(JSON.stringify(narrow)).toContain('channelId_1_createdTimestamp_1');
      expect(stagesOf(narrow)).not.toContain('COLLSCAN');
    });
  });

  it('splits a snowflake range that crosses a digit-length boundary', async () => {
    // Snowflakes reach 19 digits in 2022; the window straddles that boundary.
    const boundary = Number(((10n ** 18n) >> 22n) + 1_420_070_400_000n);
    const before = message({ author: { id: 'u2' }, at: boundary - DAY });
    const after = message({ author: { id: 'u2' }, at: boundary + DAY });
    const outside = message({ author: { id: 'u2' }, at: boundary + 3 * DAY });
    expect(before._id).toHaveLength(18);
    expect(after._id).toHaveLength(19);
    const reactions = [before, after, outside].map((target) => ({
      messageId: target._id,
      channelId: 'text',
      emojiKey: '👍',
      type: 0 as const,
      generation: 'g',
      chunk: 0,
      userIds: ['me'],
      observedAt: 0,
    }));
    const generations = { '👍:0': { generation: 'g', observedAt: 0, complete: true } };
    await withFixture(
      {
        messages: [before, after, outside].map((m) => ({ ...m, reactionGenerations: generations })),
        reactions,
      },
      async ({ repo }) => {
        const window = { startMs: boundary - 2 * DAY, endMs: boundary + 2 * DAY };
        expect(unwrap(await repo.reactionsGiven(window, 'me', scope)).total).toBe(2);
      },
    );
  });
});

describe('ArchiveStatsRepo errors and access', () => {
  it('maps an exceeded query time limit to DATABASE_QUERY_TIMEOUT', async () => {
    // Fail points need test commands, which the shared server does not enable.
    const server = await MongoMemoryServer.create({
      instance: { args: ['--setParameter', 'enableTestCommands=1'] },
    });
    const connection = await mongoose.createConnection(server.getUri('stats-timeout')).asPromise();
    try {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('2'));
      await connection.collection<ArchiveMessage>('messages').insertOne({ ...message({}) });
      await connection.db!.admin().command({
        configureFailPoint: 'maxTimeAlwaysTimeOut',
        mode: 'alwaysOn',
      });
      const repo = new MongoArchiveStatsRepo(guild);
      const result = await summaryOf(repo, WEEK, scope);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('DATABASE_QUERY_TIMEOUT');
        expect(result.error.messageKey).toBe('errors:db.query_timeout');
        expect(result.error.context.operation).toBe('MongoArchiveStatsRepo.activity');
      }
      const emoji = await repo.emojiUsage(WEEK, ['1']);
      expect(emoji.ok ? undefined : emoji.error.code).toBe('DATABASE_QUERY_TIMEOUT');
    } finally {
      await connection
        .db!.admin()
        .command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: 'off' });
      await connection.close();
      await server.stop({ doCleanup: true, force: true });
    }
  });

  it('rejects invalid arguments as programmer errors', async () => {
    await withFixture({}, async ({ repo }) => {
      await expect(summaryOf(repo, { startMs: 2, endMs: 1 }, scope)).rejects.toThrow(TypeError);
      await expect(heatmapOf(repo, WEEK, scope, 'Not/AZone')).rejects.toThrow(RangeError);
      await expect(authorsOf(repo, WEEK, scope, { limit: 0 })).rejects.toThrow(TypeError);
      await expect(
        // @ts-expect-error retention needs a previous window; the types say so first.
        repo.activity({ window: WEEK, scope, timeZone: 'UTC', sections: { retention: {} } }),
      ).rejects.toThrow('previousWindow');
      await expect(
        // @ts-expect-error an empty section set is rejected at compile time too.
        repo.activity({ window: WEEK, scope, timeZone: 'UTC', sections: {} }),
      ).rejects.toThrow('at least one section');
      await expect(
        repo.activity({
          window: WEEK,
          scope,
          timeZone: 'UTC',
          // @ts-expect-error an unknown section name does not compile.
          sections: { summary: {}, everything: {} },
        }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  it('reports a completed full backup only once one has finished completely', async () => {
    await withFixture({}, async ({ connection, repo }) => {
      expect(unwrap(await repo.fullBackupCompleted())).toBe(false);
      const job = { guildId: '1', options: {}, createdAt: T0 };
      await connection.collection('archive_jobs').insertMany([
        {
          _id: 'j1',
          jobId: 'j1',
          requestId: 'r1',
          command: 'full-backup',
          status: 'partial',
          ...job,
        },
        {
          _id: 'j2',
          jobId: 'j2',
          requestId: 'r2',
          command: 'periodic',
          status: 'complete',
          ...job,
        },
      ] as never[]);
      expect(unwrap(await repo.fullBackupCompleted())).toBe(false);
      await connection.collection('archive_jobs').insertOne({
        _id: 'j3',
        jobId: 'j3',
        requestId: 'r3',
        command: 'full-backup',
        status: 'complete',
        ...job,
      } as never);
      expect(unwrap(await repo.fullBackupCompleted())).toBe(true);
    });
  });

  it('lets a bot without archive ownership read statistics while archive writes stay refused', async () => {
    await withFixture({ messages: [message({})] }, async ({ guild }) => {
      const reader: GuildConnection = {
        guildId: guild.guildId,
        connection: guild.connection,
        models: guild.models,
      };
      const repos = buildRepos(reader);
      expect(Object.keys(repos)).not.toContain('archive');
      const report = unwrap(
        await repos.archiveStats.activity({
          window: WEEK,
          scope,
          timeZone: 'UTC',
          sections: { summary: {} },
        }),
      );
      expect(report.summary.messages).toBe(1);
      expect(unwrap(await repos.archiveStats.fullBackupCompleted())).toBe(false);
      const channels = unwrap(await repos.archiveStats.listChannels());
      expect(channels).toHaveLength(CHANNELS.length);
      expect(channels.find((channel) => channel.channelId === 'gone')).toEqual({
        channelId: 'gone',
        name: 'old-room',
        type: 0,
        access: 'deleted',
        everyoneCanView: true,
      });
      expect(() => new MongoArchiveRepo(reader, 'msg-archive')).toThrow(
        'Archive writes require msg-archive ownership',
      );
    });
  });
});
