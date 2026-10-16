import { describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoThreadModerationRepo } from '../../../src/persistence/repositories/thread-moderation.repo';
import { withFreshConnection } from '../helpers/mongo';

const fixture = async (
  run: (
    repo: MongoThreadModerationRepo,
    conn: Awaited<ReturnType<StaticConnectionManager['getConnection']>>,
  ) => Promise<void>,
): Promise<void> => {
  await withFreshConnection(async (connection) => {
    const conn = await new StaticConnectionManager(connection).getConnection(
      asGuildId('999999999999999999'),
    );
    await run(new MongoThreadModerationRepo(conn), conn);
  });
};

describe('thread message source persistence (integration)', () => {
  it('retains attribution across repository reconstruction and isolates bot/thread/message', async () => {
    await fixture(async (repo, conn) => {
      const before = Date.now();
      unwrap(await repo.recordMessageSource('bot', 'thread', 'original', 'user'));
      unwrap(await repo.recordMessageSource('bot', 'thread', 'reply', 'user'));
      const restarted = new MongoThreadModerationRepo(conn);
      expect(unwrap(await restarted.findMessageSource('bot', 'thread', 'original'))).toBe('user');
      expect(unwrap(await restarted.findMessageSource('bot', 'thread', 'reply'))).toBe('user');
      expect(
        unwrap(await restarted.findMessageSource('other', 'thread', 'original')),
      ).toBeUndefined();
      expect(unwrap(await restarted.findMessageSource('bot', 'other', 'original'))).toBeUndefined();
      expect(unwrap(await restarted.findMessageSource('bot', 'thread', 'absent'))).toBeUndefined();
      const doc = await conn.models.ThreadMessageSource.findOne({ message_id: 'original' })
        .lean()
        .exec();
      expect(doc?.expires_at.getTime()).toBeGreaterThanOrEqual(before + 604_800_000);
      expect(doc?.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 604_800_000);
      expect(Object.keys(doc ?? {}).sort()).toEqual(
        ['_id', '__v', 'bot_id', 'thread_id', 'message_id', 'user_id', 'expires_at'].sort(),
      );
      const indexes = await conn.models.ThreadMessageSource.collection.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: { bot_id: 1, thread_id: 1, message_id: 1 },
            unique: true,
          }),
          expect.objectContaining({ key: { expires_at: 1 }, expireAfterSeconds: 0 }),
        ]),
      );
    });
  });

  it('ignores expired records before the TTL monitor removes them and never extends retention on replay', async () => {
    await fixture(async (repo, conn) => {
      unwrap(await repo.recordMessageSource('bot', 'thread', 'message', 'user'));
      const expired = new Date(Date.now() - 1000);
      await conn.models.ThreadMessageSource.updateOne({}, { $set: { expires_at: expired } });
      expect(unwrap(await repo.findMessageSource('bot', 'thread', 'message'))).toBeUndefined();
      unwrap(await repo.recordMessageSource('bot', 'thread', 'message', 'user'));
      const doc = await conn.models.ThreadMessageSource.findOne().lean().exec();
      expect(doc?.expires_at.getTime()).toBe(expired.getTime());
      expect((await repo.recordMessageSource('bot', 'thread', 'message', 'imposter')).ok).toBe(
        false,
      );
    });
  });

  it('deduplicates simultaneous inserts while refusing a conflicting source', async () => {
    await fixture(async (repo, conn) => {
      const same = await Promise.all(
        Array.from({ length: 10 }, () =>
          repo.recordMessageSource('bot', 'thread', 'message', 'user'),
        ),
      );
      same.forEach(unwrap);
      expect(await conn.models.ThreadMessageSource.countDocuments()).toBe(1);
      expect((await repo.recordMessageSource('bot', 'thread', 'message', 'other')).ok).toBe(false);
      expect(unwrap(await repo.findMessageSource('bot', 'thread', 'message'))).toBe('user');
      const competing = await Promise.all(
        ['alice', 'bob'].map((user) =>
          repo.recordMessageSource('bot', 'thread', 'competing', user),
        ),
      );
      expect(competing.filter((result) => result.ok)).toHaveLength(1);
      expect(['alice', 'bob']).toContain(
        unwrap(await repo.findMessageSource('bot', 'thread', 'competing')),
      );
    });
  });

  it('returns typed errors for failed reads/writes and handles duplicate-key retries', async () => {
    await fixture(async (repo, conn) => {
      unwrap(await repo.recordMessageSource('bot', 'thread', 'message', 'user'));
      const update = vi.spyOn(conn.models.ThreadMessageSource, 'updateOne');
      update.mockImplementationOnce(() => {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      });
      unwrap(await repo.recordMessageSource('bot', 'thread', 'message', 'user'));
      update.mockImplementationOnce(() => {
        throw new Error('write unavailable');
      });
      expect((await repo.recordMessageSource('bot', 'thread', 'message', 'user')).ok).toBe(false);
      vi.spyOn(conn.models.ThreadMessageSource, 'findOne').mockImplementationOnce(() => {
        throw new Error('read unavailable');
      });
      expect((await repo.findMessageSource('bot', 'thread', 'message')).ok).toBe(false);
    });
  });
});
