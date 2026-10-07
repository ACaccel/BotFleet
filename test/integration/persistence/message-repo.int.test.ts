/**
 * Reference integration test for the persistence layer.
 *
 * Demonstrates the contract every repo integration test follows:
 *   1. Open a fresh mongoose connection against the shared memory server.
 *   2. Wrap it in a `StaticConnectionManager` so the production
 *      `MongoMessageRepo` runs against the same `GuildConnection`
 *      shape it uses in production.
 *   3. Exercise CRUD methods, asserting both happy-path and the
 *      duplicate-key tolerance contract.
 *   4. The `withFreshConnection` helper drops the database afterwards
 *      so each `it()` is fully isolated.
 *
 * Every repo method returns `Result<T, DatabaseError>`. Happy-path
 * cases unwrap with the test-only `unwrap`. Programmer errors (a non-
 * positive `limit`) still throw `TypeError` — they are not a domain
 * failure and never enter the `Result` channel.
 */
import { describe, expect, it } from 'vitest';
import { asChannelId, asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoMessageRepo } from '../../../src/persistence/repositories/message.repo';
import type { MessageDoc } from '../../../src/persistence/schemas/message.schema';
import { withFreshConnection } from '../helpers/mongo';

const channelId = asChannelId('111111111111111111');
const otherChannelId = asChannelId('222222222222222222');
const guildId = asGuildId('999999999999999999');

const buildMessageDoc = (overrides: Partial<MessageDoc> & { messageId: string }): MessageDoc =>
  ({
    channelId: String(channelId),
    channelName: 'general',
    content: 'hello',
    userId: 'user-1',
    userName: 'tester',
    timestamp: Date.now(),
    attachments: [],
    reactions: [],
    stickers: [],
    ...overrides,
  }) as MessageDoc;

/** Recursively collect every `stage` label from an explain plan tree. */
const collectStages = (node: unknown, acc: string[] = []): string[] => {
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['stage'] === 'string') acc.push(obj['stage']);
    const single = obj['inputStage'];
    if (single !== undefined) collectStages(single, acc);
    const many = obj['inputStages'];
    if (Array.isArray(many)) for (const s of many) collectStages(s, acc);
  }
  return acc;
};

const winningPlanOf = (explain: unknown): unknown => {
  const planner = (explain as Record<string, unknown>)['queryPlanner'];
  return planner !== undefined ? (planner as Record<string, unknown>)['winningPlan'] : undefined;
};

describe('MongoMessageRepo (integration)', () => {
  it('countAll returns 0 on an empty collection', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      expect(unwrap(await repo.countAll())).toBe(0);
    });
  });

  it('insertManyIgnoringDuplicates writes new docs and reports the count', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);

      const result = unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'm1' }),
          buildMessageDoc({ messageId: 'm2' }),
          buildMessageDoc({ messageId: 'm3' }),
        ]),
      );

      expect(result).toEqual({ inserted: 3, duplicates: 0 });
      expect(unwrap(await repo.countAll())).toBe(3);
    });
  });

  it('insertManyIgnoringDuplicates tolerates duplicate messageId without aborting the batch', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);

      unwrap(await repo.insertManyIgnoringDuplicates([buildMessageDoc({ messageId: 'm1' })]));

      const result = unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'm1' }), // duplicate
          buildMessageDoc({ messageId: 'm2' }),
          buildMessageDoc({ messageId: 'm3' }),
        ]),
      );

      expect(result.inserted).toBe(2);
      expect(result.duplicates).toBe(1);
      expect(unwrap(await repo.countAll())).toBe(3);
    });
  });

  it('findRecentByChannel returns newest-first, scoped to channelId, capped by limit', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);

      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'a', timestamp: 100 }),
          buildMessageDoc({ messageId: 'b', timestamp: 200 }),
          buildMessageDoc({ messageId: 'c', timestamp: 300 }),
          buildMessageDoc({
            messageId: 'd',
            timestamp: 400,
            channelId: String(otherChannelId),
          }),
        ]),
      );

      const recent = unwrap(await repo.findRecentByChannel(channelId, 2));
      expect(recent.map((d) => d.messageId)).toEqual(['c', 'b']);
    });
  });

  it('findRecentByChannel rejects a non-positive limit with TypeError (programmer error, not a Result)', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      await expect(repo.findRecentByChannel(channelId, 0)).rejects.toThrow(TypeError);
      await expect(repo.findRecentByChannel(channelId, -1)).rejects.toThrow(TypeError);
      await expect(repo.findRecentByChannel(channelId, 1.5)).rejects.toThrow(TypeError);
    });
  });

  it('findByTimestampRange rejects an invalid window with TypeError', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      await expect(repo.findByTimestampRange(200, 100)).rejects.toThrow(TypeError);
      await expect(repo.findByTimestampRange(Number.NaN, 100)).rejects.toThrow(TypeError);
    });
  });

  it('findRecentByChannel returns every match when limit >= data size', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);

      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'a', timestamp: 100 }),
          buildMessageDoc({ messageId: 'b', timestamp: 200 }),
        ]),
      );
      const all = unwrap(await repo.findRecentByChannel(channelId, 100));
      expect(all.map((d) => d.messageId)).toEqual(['b', 'a']);
    });
  });

  it('findByMessageId returns ok(undefined) when the message is not stored', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      expect(unwrap(await repo.findByMessageId('does-not-exist'))).toBeUndefined();
    });
  });

  it('findByMessageId returns the stored doc when present', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'unique-id', content: 'find me' }),
        ]),
      );
      const doc = unwrap(await repo.findByMessageId('unique-id'));
      expect(doc?.content).toBe('find me');
    });
  });

  it('findExistingMessageIds returns the subset already stored', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'm1' }),
          buildMessageDoc({ messageId: 'm2' }),
        ]),
      );
      const existing = unwrap(await repo.findExistingMessageIds(['m1', 'm3']));
      expect([...existing].sort()).toEqual(['m1']);
    });
  });

  it('findByTimestampRange returns numeric-timestamp docs within the half-open window', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);

      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'a', timestamp: 100 }),
          buildMessageDoc({ messageId: 'b', timestamp: 200 }),
          buildMessageDoc({ messageId: 'c', timestamp: 300 }),
        ]),
      );

      // Half-open [100, 300): includes 100 and 200, excludes 300.
      const got = unwrap(await repo.findByTimestampRange(100, 300));
      expect(got.map((d) => d.messageId).sort()).toEqual(['a', 'b']);
    });
  });

  it('findByTimestampRange excludes a legacy String-typed timestamp until it is converted', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      const raw = connection.db?.collection('messages');
      if (raw === undefined) throw new Error('no resolved db handle');

      // Insert a legacy String-typed timestamp via the raw driver, bypassing
      // mongoose's Number cast — the exact shape the pre-refactor schema left
      // behind and that msg-archive timestamp repair backfills.
      await raw.insertOne({
        channelId: String(channelId),
        channelName: 'general',
        messageId: 'legacy',
        userId: 'u',
        userName: 't',
        timestamp: '1700000000000',
        attachments: [],
        reactions: [],
        stickers: [],
      });

      const startMs = 1_699_000_000_000;
      const endMs = 1_701_000_000_000;

      // The sargable predicate cannot match a String-typed value (string vs
      // number BSON bracket) — this is the silent-exclusion hazard the
      // migration gate exists to prevent.
      const before = unwrap(await repo.findByTimestampRange(startMs, endMs));
      expect(before.map((d) => d.messageId)).not.toContain('legacy');

      // Apply the same conversion msg-archive timestamp repair runs
      // (buildConvertFilter + buildConvertPipeline, asserted shape-for-shape
      // in test/integration/plugins/message-backup/repair.int.test.ts).
      await raw.updateMany({ timestamp: { $type: 'string', $regex: /^[0-9]+$/ } }, [
        {
          $set: {
            timestamp: { $convert: { input: '$timestamp', to: 'long', onError: '$timestamp' } },
          },
        },
      ]);

      const after = unwrap(await repo.findByTimestampRange(startMs, endMs));
      expect(after.map((d) => d.messageId)).toContain('legacy');
    });
  });

  it('findByChannelAndTimestampRange is served by the compound index with no blocking SORT', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      // getConnection runs model.init(), which builds the schema-declared
      // { channelId: 1, timestamp: 1 } index this query relies on.
      const guildConn = await manager.getConnection(guildId);
      const repo = new MongoMessageRepo(guildConn);
      unwrap(
        await repo.insertManyIgnoringDuplicates([
          buildMessageDoc({ messageId: 'a', timestamp: 100 }),
          buildMessageDoc({ messageId: 'b', timestamp: 200 }),
        ]),
      );

      // Hint the compound index so the assertion is deterministic regardless
      // of the planner's cost choice on a tiny test collection: with the
      // index in use, an index-provided sort must produce no SORT stage.
      const explain: unknown = await guildConn.models.Message.collection
        .find({ channelId: String(channelId), timestamp: { $gte: 0, $lt: 1_000 } })
        .sort({ timestamp: 1 })
        .hint({ channelId: 1, timestamp: 1 })
        .explain('queryPlanner');
      const stages = collectStages(winningPlanOf(explain));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('SORT');
    });
  });
});
