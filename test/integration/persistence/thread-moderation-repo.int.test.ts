import { describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoThreadModerationRepo } from '../../../src/persistence/repositories/thread-moderation.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');

describe('MongoThreadModerationRepo (integration)', () => {
  it('persists multiple restrictions across repository reconstruction and isolates bot/thread keys', async () => {
    await withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const conn = await manager.getConnection(guildId);
      const repo = new MongoThreadModerationRepo(conn);
      unwrap(await repo.setBlocked('bot-a', 'thread-a', ['alice', 'bob', 'alice'], true));
      await manager.close(guildId);
      // Rebuild all model state while retaining the database contents.
      connection.deleteModel(/.*/);
      const restarted = new MongoThreadModerationRepo(await manager.getConnection(guildId));
      expect(unwrap(await restarted.isBlocked('bot-a', 'thread-a', 'alice'))).toBe(true);
      expect(unwrap(await restarted.isBlocked('bot-a', 'thread-a', 'bob'))).toBe(true);
      expect(unwrap(await restarted.isBlocked('bot-b', 'thread-a', 'alice'))).toBe(false);
      expect(unwrap(await restarted.isBlocked('bot-a', 'thread-b', 'alice'))).toBe(false);
      expect(unwrap(await restarted.isBlocked('bot-a', 'thread-a', 'carol'))).toBe(false);
      expect(unwrap(await restarted.listBlocked('bot-a', 'thread-a'))).toEqual(['alice', 'bob']);
      expect(unwrap(await restarted.listBlocked('bot-b', 'thread-a'))).toEqual([]);
      expect(unwrap(await restarted.listBlocked('bot-a', 'thread-b'))).toEqual([]);
      const stored = await conn.models.ThreadModeration.findOne().lean().exec();
      expect(stored?.blocked_user_ids).toEqual(['alice', 'bob']);
    });
  });

  it('unblocks only selected users without creating absent thread documents', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoThreadModerationRepo(conn);
      unwrap(await repo.setBlocked('bot', 'missing', ['alice'], false));
      unwrap(await repo.setBlocked('bot', 'empty', [], true));
      expect(await conn.models.ThreadModeration.countDocuments()).toBe(0);
      unwrap(await repo.setBlocked('bot', 'thread', ['alice', 'bob', 'carol'], true));
      unwrap(await repo.setBlocked('bot', 'other', ['alice'], true));
      unwrap(await repo.setBlocked('bot', 'thread', ['alice', 'bob'], false));
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'alice'))).toBe(false);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'bob'))).toBe(false);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'carol'))).toBe(true);
      expect(unwrap(await repo.isBlocked('bot', 'other', 'alice'))).toBe(true);
      expect(unwrap(await repo.listBlocked('bot', 'missing'))).toEqual([]);
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual(['carol']);
      expect(unwrap(await repo.listBlocked('bot', 'other'))).toEqual(['alice']);
      unwrap(await repo.setBlocked('bot', 'thread', ['carol'], false));
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual([]);
    });
  });

  it('preserves concurrent bans and simultaneous changes to different users', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoThreadModerationRepo(conn);
      const users = Array.from({ length: 12 }, (_, i) => `user-${i}`);
      const results = await Promise.all(
        users.map((user) => repo.setBlocked('bot', 'thread', [user], true)),
      );
      results.forEach(unwrap);
      expect(await conn.models.ThreadModeration.countDocuments()).toBe(1);
      const stored = await conn.models.ThreadModeration.findOne().lean().exec();
      expect(stored?.blocked_user_ids.sort()).toEqual([...users].sort());
      const concurrent = await Promise.all([
        repo.setBlocked('bot', 'thread', ['user-0', 'user-1'], false),
        repo.setBlocked('bot', 'thread', ['extra'], true),
      ]);
      concurrent.forEach(unwrap);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'user-0'))).toBe(false);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'extra'))).toBe(true);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'user-2'))).toBe(true);
    });
  });

  it('checks delegated manager authority atomically for bans and allows without upserting', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoThreadModerationRepo(conn);
      expect((await repo.setBlocked('bot', 'missing', ['target'], true, 'manager')).ok).toBe(false);
      expect((await repo.setBlocked('bot', 'missing', ['target'], false, 'manager')).ok).toBe(
        false,
      );
      expect(await conn.models.ThreadModeration.countDocuments()).toBe(0);
      unwrap(await repo.setManager('bot', 'thread', 'manager', 'admin', true, 1));
      unwrap(await repo.setManager('bot', 'thread', 'protected', 'admin', true, 1));
      unwrap(await repo.setBlocked('bot', 'thread', ['target'], true, 'manager'));
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'target'))).toBe(true);
      expect(
        (await repo.setBlocked('bot', 'thread', ['protected', 'other'], true, 'manager')).ok,
      ).toBe(false);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'other'))).toBe(false);
      unwrap(await repo.setBlocked('bot', 'thread', ['target'], false, 'manager'));
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'target'))).toBe(false);
      unwrap(await repo.setBlocked('bot', 'thread', ['target'], true));
      unwrap(await repo.setManager('bot', 'thread', 'manager', 'admin', false, 2));
      expect((await repo.setBlocked('bot', 'thread', ['other'], true, 'manager')).ok).toBe(false);
      expect((await repo.setBlocked('bot', 'thread', ['target'], false, 'manager')).ok).toBe(false);
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual(['target']);
      // Owner/admin writes do not need a delegated-manager record.
      unwrap(await repo.setBlocked('bot', 'thread', ['target'], false));
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual([]);
    });
  });

  it('retries a first-insert conflict and translates failed queries and writes into Results', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoThreadModerationRepo(conn);
      unwrap(await repo.setBlocked('bot', 'thread', ['alice'], true));
      const update = vi.spyOn(conn.models.ThreadModeration, 'updateOne');
      update.mockImplementationOnce(() => {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      });
      unwrap(await repo.setBlocked('bot', 'thread', ['bob'], true));
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'bob'))).toBe(true);
      expect(update).toHaveBeenLastCalledWith(
        { bot_id: 'bot', thread_id: 'thread', manager_ids: { $nin: ['bob'] } },
        { $addToSet: { blocked_user_ids: { $each: ['bob'] } } },
        { upsert: false, runValidators: true },
      );
      update.mockImplementationOnce(() => {
        throw new Error('write unavailable');
      });
      const failedWrite = await repo.setBlocked('bot', 'thread', ['alice'], false);
      expect(failedWrite.ok).toBe(false);
      if (!failedWrite.ok) {
        expect(failedWrite.error.context.operation).toBe('MongoThreadModerationRepo.setBlocked');
      }
      update.mockImplementationOnce(() => {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      });
      update.mockImplementationOnce(() => {
        throw new Error('retry unavailable');
      });
      const failedRetry = await repo.setBlocked('bot', 'thread', ['carol'], true);
      expect(failedRetry.ok).toBe(false);
      if (!failedRetry.ok) {
        expect(failedRetry.error.context.operation).toBe(
          'MongoThreadModerationRepo.setBlocked.retry',
        );
      }
      vi.spyOn(conn.models.ThreadModeration, 'exists').mockImplementationOnce(() => {
        throw new Error('read unavailable');
      });
      vi.spyOn(conn.models.ThreadModeration, 'findOne').mockImplementationOnce(() => {
        throw new Error('list unavailable');
      });
      const failedList = await repo.listBlocked('bot', 'thread');
      expect(failedList.ok).toBe(false);
      if (!failedList.ok) {
        expect(failedList.error.context.operation).toBe('MongoThreadModerationRepo.listBlocked');
      }
      const failedRead = await repo.isBlocked('bot', 'thread', 'alice');
      expect(failedRead.ok).toBe(false);
      if (!failedRead.ok) {
        expect(failedRead.error.context.operation).toBe('MongoThreadModerationRepo.isBlocked');
      }
    });
  });
});
