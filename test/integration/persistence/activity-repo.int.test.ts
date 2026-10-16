/**
 * Integration coverage for `MongoActivityRepo`: joins respect the status
 * and capacity even under concurrent clicks, and finishing schedules the
 * purge only from the expected states.
 */
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoActivityRepo,
  type ActivityInput,
} from '../../../src/persistence/repositories/activity.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999997');

const input = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  activity_id: 'a1',
  message_id: 'a1',
  channel_id: 'c1',
  title: 'Board games',
  description: '',
  creator_id: 'creator',
  expired_at: Date.now() + 60_000,
  ...overrides,
});

const repoFor = async (connection: Parameters<Parameters<typeof withFreshConnection>[0]>[0]) =>
  new MongoActivityRepo(await new StaticConnectionManager(connection).getConnection(guildId));

describe('MongoActivityRepo (integration)', () => {
  it('joins and leaves once per member', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await repoFor(connection);
      unwrap(await repo.create(input()));
      expect(unwrap(await repo.join('a1', 'u1'))).toBe(true);
      expect(unwrap(await repo.join('a1', 'u1'))).toBe(false);
      expect(unwrap(await repo.leave('a1', 'u1'))).toBe(true);
      expect(unwrap(await repo.leave('a1', 'u1'))).toBe(false);
    });
  });

  it('never exceeds the capacity, even with simultaneous joins', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await repoFor(connection);
      unwrap(await repo.create(input({ capacity: 2 })));
      const results = await Promise.all(['u1', 'u2', 'u3', 'u4'].map((id) => repo.join('a1', id)));
      expect(results.map(unwrap).filter(Boolean)).toHaveLength(2);
      expect(unwrap(await repo.findByActivityId('a1'))?.participants).toHaveLength(2);
    });
  });

  it('refuses joins after closing and only cancels from open or closed', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await repoFor(connection);
      unwrap(await repo.create(input()));
      const purge = new Date(Date.now() + 1_000_000);
      expect(unwrap(await repo.finish('a1', ['open'], 'closed', purge))).toBe(true);
      expect(unwrap(await repo.finish('a1', ['open'], 'closed', purge))).toBe(false);
      expect(unwrap(await repo.join('a1', 'u1'))).toBe(false);
      expect(unwrap(await repo.finish('a1', ['open', 'closed'], 'cancelled', purge))).toBe(true);
      const doc = unwrap(await repo.findByActivityId('a1'));
      expect(doc?.status).toBe('cancelled');
      expect(doc?.purge_at?.getTime()).toBe(purge.getTime());
    });
  });

  it('records attendance and start reminders', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await repoFor(connection);
      unwrap(await repo.create(input({ starts_at: Date.now() + 1000 })));
      expect(unwrap(await repo.markStartNotified('a1'))).toBe(true);
      expect(unwrap(await repo.markStartNotified('a1'))).toBe(false);
      unwrap(await repo.addAttendance('a1', { at: 1, present: ['u1'], total: 3 }));
      const doc = unwrap(await repo.findByActivityId('a1'));
      expect(doc?.attendance.map((entry) => [entry.present, entry.total])).toEqual([[['u1'], 3]]);
      expect(unwrap(await repo.listAll())).toHaveLength(1);
    });
  });
});
