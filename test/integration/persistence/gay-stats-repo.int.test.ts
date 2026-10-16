import { describe, expect, it } from 'vitest';
import type { ArchiveMessage } from '../../../src/core/archive/types';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoGayStatsRepo } from '../../../src/persistence/repositories/gay-stats.repo';
import { withFreshConnection } from '../helpers/mongo';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const QUERY = {
  userIds: ['a', 'b'],
  channelIds: ['visible', 'second'],
  window: { startMs: START, endMs: START + 30 * DAY },
  timeZone: 'Asia/Taipei',
};
let nextId = 0;
const message = (fields: Partial<ArchiveMessage> = {}): ArchiveMessage => ({
  _id: String(nextId++),
  schemaVersion: 3,
  channelId: 'visible',
  author: { id: 'a' },
  type: 0,
  createdTimestamp: START,
  observedAt: START,
  content: 'hello',
  mentions: { users: [] },
  ...fields,
});

const withMessages = (
  messages: readonly ArchiveMessage[],
  body: (repo: MongoGayStatsRepo) => Promise<void>,
): Promise<void> =>
  withFreshConnection(async (connection) => {
    const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
    await connection.collection('messages').createIndex({ channelId: 1, createdTimestamp: 1 });
    if (messages.length > 0)
      await connection.collection<ArchiveMessage>('messages').insertMany([...messages]);
    await body(new MongoGayStatsRepo(guild));
  });

describe('MongoGayStatsRepo summaries', () => {
  it('caps interactions per local date, deduplicates reply mentions, and sorts pair orientation', async () => {
    const reply = (author: string, recipient: string, at: number) =>
      message({
        author: { id: author },
        createdTimestamp: at,
        type: 19,
        reference: { authorId: recipient },
        mentions: { users: [recipient] },
      });
    await withMessages(
      [
        reply('a', 'b', START),
        reply('a', 'b', START + 1),
        reply('b', 'a', START + 2),
        message({ mentions: { users: ['b'] } }),
        message({ mentions: { users: ['b'] } }),
        reply('a', 'b', START + DAY),
        message({ author: { id: 'b' }, createdTimestamp: START + DAY, channelId: 'second' }),
        message({ author: { id: 'a' }, createdTimestamp: START + 2 * DAY, channelId: 'second' }),
        message({ author: { id: 'b' }, createdTimestamp: START + 2 * DAY, channelId: 'second' }),
        message({ author: { id: 'a' }, createdTimestamp: START + 2 * DAY }),
        message({ author: { id: 'b' }, createdTimestamp: START + 2 * DAY }),
      ],
      async (repo) => {
        const result = unwrap(await repo.summarize({ ...QUERY, userIds: ['b', 'a'] }));
        expect(result?.members).toEqual([
          { userId: 'a', messages: 7, activeDays: 3, emojiRatio: 0 },
          { userId: 'b', messages: 4, activeDays: 3, emojiRatio: 0 },
        ]);
        expect(result?.pair).toEqual({
          repliesABDays: 2,
          repliesBADays: 1,
          mentionsABDays: 1,
          mentionsBADays: 0,
          sharedChannelDays: 2,
        });
        expect(unwrap(await repo.summarize(QUERY))).toEqual(result);
      },
    );
  });

  it('filters hidden, other-author, bot, webhook, deleted, system, and out-of-window messages', async () => {
    await withMessages(
      [
        message(),
        message({ channelId: 'hidden' }),
        message({ author: { id: 'c' } }),
        message({ author: { id: 'a', bot: true } }),
        message({ webhookId: 'webhook' }),
        message({ deletedAt: START + 1 }),
        message({ type: 7 }),
        message({ createdTimestamp: START - 1 }),
        message({ createdTimestamp: QUERY.window.endMs }),
      ],
      async (repo) => {
        expect(unwrap(await repo.summarize(QUERY))).toEqual({
          members: [{ userId: 'a', messages: 1, activeDays: 1, emojiRatio: 0 }],
        });
        expect(unwrap(await repo.summarize({ ...QUERY, channelIds: [] }))).toBeUndefined();
      },
    );
  });

  it('uses local dates across a UTC midnight boundary', async () => {
    await withMessages(
      [
        message({ createdTimestamp: START + 15 * 3_600_000 }),
        message({ createdTimestamp: START + 16 * 3_600_000 }),
      ],
      async (repo) => {
        expect(
          unwrap(await repo.summarize({ ...QUERY, userIds: ['a'] }))?.members[0]?.activeDays,
        ).toBe(2);
        expect(
          unwrap(await repo.summarize({ ...QUERY, userIds: ['a'], timeZone: 'UTC' }))?.members[0]
            ?.activeDays,
        ).toBe(1);
      },
    );
  });

  it('detects Unicode, VS16, keycap, and custom emoji without counting bare digits or text symbols', async () => {
    await withMessages(
      ['123 # * © ❤', '😀', '❤️', '1️⃣', '1⃣', '<:smile:123>', '<a:dance:456>', '🇹🇼', '🀄'].map(
        (content) => message({ content }),
      ),
      async (repo) => {
        expect(
          unwrap(await repo.summarize({ ...QUERY, userIds: ['a'] }))?.members[0]?.emojiRatio,
        ).toBe(8 / 9);
      },
    );
  });

  it('omits unknown content and interaction fields instead of treating them as zero', async () => {
    const unknown = message({ type: 19 });
    delete unknown.content;
    delete unknown.mentions;
    await withMessages([unknown, message({ author: { id: 'b' } })], async (repo) => {
      const summary = unwrap(await repo.summarize(QUERY));
      expect(summary?.members[0]).toEqual({ userId: 'a', messages: 1, activeDays: 1 });
      expect(summary?.pair).toEqual({ repliesBADays: 0, mentionsBADays: 0, sharedChannelDays: 1 });
    });
  });

  it('does not suppress explicit mentions on a forwarded message', async () => {
    await withMessages(
      [
        message({ reference: { type: 1, authorId: 'b' }, mentions: { users: ['b'] } }),
        message({ author: { id: 'b' } }),
      ],
      async (repo) => {
        expect(unwrap(await repo.summarize(QUERY))?.pair).toMatchObject({
          repliesABDays: 0,
          mentionsABDays: 1,
        });
      },
    );
  });

  it('returns no summary for an empty archive', async () => {
    await withMessages([], async (repo) => {
      expect(unwrap(await repo.summarize(QUERY))).toBeUndefined();
      expect(unwrap(await repo.listChannels())).toEqual([]);
    });
  });

  it('can summarize legacy archives without the hinted compound index', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
      await connection.collection<ArchiveMessage>('messages').insertOne(message());
      const collection = connection.collection('messages');
      const indexes = await collection.listIndexes().toArray();
      for (const index of indexes)
        if (index.name !== '_id_' && index.name !== undefined)
          await collection.dropIndex(index.name);
      const repo = new MongoGayStatsRepo(guild);
      expect(unwrap(await repo.summarize({ ...QUERY, userIds: ['a'] }))).toEqual({
        members: [{ userId: 'a', messages: 1, activeDays: 1, emojiRatio: 0 }],
      });
    });
  });
});
