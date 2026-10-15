/** `MongoNotificationThreadRepo`: per-bot thread records that upsert and expire. */
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoNotificationThreadRepo } from '../../../src/persistence/repositories/notification-thread.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999994');
const id = { botId: 'konata', route: 'deploy', threadKey: 'b5ffd42-1' };

describe('MongoNotificationThreadRepo (integration)', () => {
  it('saves, replaces and finds a thread scoped by bot, route and key', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoNotificationThreadRepo(conn);

      expect(unwrap(await repo.find(id))).toBeUndefined();
      unwrap(await repo.save(id, { channelId: 'c1', messageId: 'm1' }, new Date(1_000)));
      unwrap(await repo.save(id, { channelId: 'c1', messageId: 'm2' }, new Date(2_000)));

      expect(unwrap(await new MongoNotificationThreadRepo(conn).find(id))).toEqual({
        channelId: 'c1',
        messageId: 'm2',
      });
      expect(unwrap(await repo.find({ ...id, botId: 'nijika' }))).toBeUndefined();
      expect(unwrap(await repo.find({ ...id, route: 'other' }))).toBeUndefined();
      expect(await conn.models.NotificationThread.countDocuments()).toBe(1);
      const doc = await conn.models.NotificationThread.findOne().lean().exec();
      expect(doc?.updated_at.getTime()).toBe(2_000);

      const indexes = await conn.models.NotificationThread.collection.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: { bot_id: 1, route: 1, thread_key: 1 }, unique: true }),
          expect.objectContaining({ key: { updated_at: 1 }, expireAfterSeconds: 2_592_000 }),
        ]),
      );
    });
  });

  it('returns a DatabaseError when the connection is closed', async () => {
    const repo = await withClosedConnection(
      async (connection) =>
        new MongoNotificationThreadRepo(
          await new StaticConnectionManager(connection).getConnection(guildId),
        ),
    );

    const found = await repo.find(id);
    const saved = await repo.save(id, { channelId: 'c', messageId: 'm' }, new Date());
    expect(found.ok ? undefined : found.error.context.operation).toBe(
      'MongoNotificationThreadRepo.find',
    );
    expect(saved.ok ? undefined : saved.error.context.operation).toBe(
      'MongoNotificationThreadRepo.save',
    );
  });
});
