import { describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoThreadModerationRepo,
  type ThreadClaim,
} from '../../../src/persistence/repositories/thread-moderation.repo';
import { withFreshConnection } from '../helpers/mongo';

const claim = (id = 'claim', requestedAt = 1_000_000, applicant = 'applicant'): ThreadClaim => ({
  id,
  applicant_id: applicant,
  owner_id: 'owner',
  reason: 'Account recovery',
  requested_at: requestedAt,
  expires_at: requestedAt + 604_800_000,
  status: 'pending',
  notices: [],
});
const notices = [{ admin_id: 'admin', channel_id: 'dm', message_id: 'message' }];
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
const submit = async (repo: MongoThreadModerationRepo, item = claim()): Promise<void> => {
  expect(unwrap(await repo.createClaim('bot', 'thread', item))).toBe('created');
  expect(unwrap(await repo.bindClaimNotices('bot', 'thread', item.id, notices))).toBe(true);
  expect(
    unwrap(await repo.completeClaimDelivery('bot', 'thread', item.id, item.requested_at + 1)),
  ).toBe(true);
};
const decide = (
  repo: MongoThreadModerationRepo,
  approved: boolean,
  id = 'claim',
  now = 1_000_001,
) => repo.decideClaim('bot', 'thread', id, 'admin', 'dm', 'message', approved, now);

describe('thread claims and managers (integration)', () => {
  it('deduplicates concurrent first requests and scopes claims to bot/thread', async () => {
    await fixture(async (repo) => {
      const outcomes = (
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            repo.createClaim('bot', 'thread', claim(`claim-${i}`)),
          ),
        )
      ).map(unwrap);
      expect(outcomes.filter((v) => v === 'created')).toHaveLength(1);
      expect(outcomes.filter((v) => v === 'duplicate')).toHaveLength(9);
      expect(unwrap(await repo.createClaim('other', 'thread', claim()))).toBe('created');
      expect(unwrap(await repo.createClaim('bot', 'other', claim()))).toBe('created');
      expect(unwrap(await repo.findClaim('absent', 'thread', 'claim'))).toBeUndefined();
    });
  });

  it('enforces cooldown, expiry and notice binding', async () => {
    await fixture(async (repo) => {
      expect(unwrap(await repo.createClaim('bot', 'thread', claim()))).toBe('created');
      expect(unwrap(await repo.bindClaimNotices('bot', 'thread', 'claim', []))).toBe(false);
      expect(unwrap(await decide(repo, true))).toBe(false);
      expect(unwrap(await repo.bindClaimNotices('bot', 'thread', 'claim', notices))).toBe(true);
      expect(unwrap(await repo.bindClaimNotices('bot', 'thread', 'claim', notices))).toBe(false);
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 1_000_001))).toBe(
        true,
      );
      for (const args of [
        ['wrong', 'dm', 'message'],
        ['admin', 'wrong', 'message'],
        ['admin', 'dm', 'wrong'],
      ]) {
        expect(
          unwrap(
            await repo.decideClaim(
              'bot',
              'thread',
              'claim',
              args[0]!,
              args[1]!,
              args[2]!,
              true,
              1_000_001,
            ),
          ),
        ).toBe(false);
      }
      expect(unwrap(await decide(repo, true, 'claim', claim().expires_at))).toBe(false);
      expect(unwrap(await repo.failClaimDelivery('bot', 'thread', 'claim'))).toBe(true);
      expect(unwrap(await repo.failClaimDelivery('bot', 'thread', 'claim'))).toBe(false);
      expect(unwrap(await repo.createClaim('bot', 'thread', claim('next', 1_000_001)))).toBe(
        'cooldown',
      );
      expect(unwrap(await repo.createClaim('bot', 'thread', claim('next', 1_060_000)))).toBe(
        'created',
      );
      expect(unwrap(await decide(repo, true))).toBe(false);
    });
  });

  it('allows exactly one concurrent decision and persists its audit record', async () => {
    await fixture(async (repo, conn) => {
      await submit(repo);
      const outcomes = (await Promise.all([decide(repo, true), decide(repo, false)])).map(unwrap);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const restarted = new MongoThreadModerationRepo(conn);
      const stored = unwrap(await restarted.findClaim('bot', 'thread', 'claim'));
      expect(stored?.reviewed_by).toBe('admin');
      expect(stored?.reviewed_at).toBe(1_000_001);
      expect(unwrap(await restarted.isManager('bot', 'thread', 'applicant'))).toBe(
        stored?.status === 'approved',
      );
      const doc = await conn.models.ThreadModeration.findOne().lean().exec();
      expect(doc?.management_log).toHaveLength(1);
      expect(unwrap(await decide(restarted, true))).toBe(false);
    });
  });

  it('approves atomically with unblocking and never regrants after revocation', async () => {
    await fixture(async (repo, conn) => {
      unwrap(await repo.setBlocked('bot', 'thread', ['applicant', 'other'], true));
      await submit(repo);
      expect(unwrap(await decide(repo, true))).toBe(true);
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual(['other']);
      expect(unwrap(await repo.listManagers('bot', 'thread'))).toEqual(['applicant']);
      expect(unwrap(await repo.isManager('other', 'thread', 'applicant'))).toBe(false);
      expect(unwrap(await repo.isManager('bot', 'other', 'applicant'))).toBe(false);
      expect(unwrap(await repo.listManagers('bot', 'missing'))).toEqual([]);
      unwrap(await repo.setManager('bot', 'thread', 'applicant', 'admin', false, 1_000_002));
      expect(unwrap(await decide(new MongoThreadModerationRepo(conn), true))).toBe(false);
      expect(unwrap(await repo.isManager('bot', 'thread', 'applicant'))).toBe(false);
      expect(unwrap(await decide(repo, true, 'missing'))).toBe(false);
    });
  });

  it('revocation invalidates older pending requests and races safely with approval', async () => {
    await fixture(async (repo) => {
      await submit(repo);
      unwrap(await repo.setManager('bot', 'thread', 'applicant', 'admin', false, 1_000_002));
      expect(unwrap(await decide(repo, true))).toBe(false);
      expect(unwrap(await repo.findClaim('bot', 'thread', 'claim'))?.status).toBe('rejected');
      await submit(repo, claim('later', 1_060_000));
      await Promise.all([
        decide(repo, true, 'later', 1_060_001),
        repo.setManager('bot', 'thread', 'applicant', 'admin', false, 1_060_002),
      ]);
      expect(unwrap(await repo.isManager('bot', 'thread', 'applicant'))).toBe(false);
    });
  });

  it('lists only configured managers for the selected bot and guild across threads', async () => {
    await fixture(async (repo, conn) => {
      expect(unwrap(await repo.listGuildManagers('bot'))).toEqual([]);
      unwrap(await repo.setManager('bot', 'thread', 'user', 'admin', true, 1));
      unwrap(await repo.setManager('bot', 'thread', 'other', 'admin', true, 2));
      unwrap(await repo.setManager('bot', 'another-thread', 'user', 'admin', true, 3));
      unwrap(await repo.setManager('other-bot', 'thread', 'excluded', 'admin', true, 4));
      unwrap(await repo.setManager('bot', 'revoked', 'excluded', 'admin', true, 5));
      unwrap(await repo.setManager('bot', 'revoked', 'excluded', 'admin', false, 6));
      unwrap(await repo.setBlocked('bot', 'banned-only', ['blocked'], true));
      await conn.models.ThreadModeration.collection.insertOne({
        bot_id: 'bot',
        thread_id: 'legacy',
        blocked_user_ids: ['blocked'],
      });
      await fixture(async (otherGuildRepo) => {
        unwrap(await otherGuildRepo.setManager('bot', 'thread', 'excluded', 'admin', true, 1));
        const restarted = new MongoThreadModerationRepo(conn);
        expect(unwrap(await restarted.listGuildManagers('bot'))).toEqual(
          expect.arrayContaining([
            { threadId: 'thread', userId: 'user' },
            { threadId: 'thread', userId: 'other' },
            { threadId: 'another-thread', userId: 'user' },
          ]),
        );
        expect(unwrap(await restarted.listGuildManagers('bot'))).toHaveLength(3);
      });
    });
  });

  it('never bans a manager during concurrent grants and bans', async () => {
    await fixture(async (repo, conn) => {
      for (let i = 0; i < 8; i++) {
        const id = `user-${i}`;
        const [, grant] = await Promise.all([
          repo.setBlocked('bot', 'thread', [id], true),
          repo.setManager('bot', 'thread', id, 'admin', true, 1_000_000),
        ]);
        unwrap(grant);
        expect(unwrap(await repo.isBlocked('bot', 'thread', id))).toBe(false);
        expect(unwrap(await repo.isManager('bot', 'thread', id))).toBe(true);
      }
      expect((await repo.setBlocked('bot', 'thread', ['user-0', 'new'], true)).ok).toBe(false);
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'new'))).toBe(false);
      const doc = await conn.models.ThreadModeration.findOne().lean().exec();
      expect(doc?.blocked_user_ids).toEqual([]);
      // Protect reads even if legacy data contains an inconsistent restriction.
      await conn.models.ThreadModeration.updateOne(
        {},
        { $addToSet: { blocked_user_ids: 'user-0' } },
      );
      expect(unwrap(await repo.isBlocked('bot', 'thread', 'user-0'))).toBe(false);
    });
  });

  it('revokes safely from legacy documents without claim arrays', async () => {
    await fixture(async (repo, conn) => {
      await conn.models.ThreadModeration.collection.insertOne({
        bot_id: 'bot',
        thread_id: 'thread',
        blocked_user_ids: ['blocked'],
      });
      unwrap(await repo.setManager('bot', 'thread', 'applicant', 'admin', false, 1_000_000));
      expect(unwrap(await repo.listManagers('bot', 'thread'))).toEqual([]);
      expect(unwrap(await repo.listBlocked('bot', 'thread'))).toEqual(['blocked']);
      await submit(repo);
      expect(unwrap(await decide(repo, true))).toBe(true);
    });
  });

  it('recovers interrupted delivery before or after notice binding after the five-minute lease', async () => {
    await fixture(async (repo, conn) => {
      for (const bound of [false, true]) {
        const thread = bound ? 'bound' : 'unbound';
        expect(unwrap(await repo.createClaim('bot', thread, claim()))).toBe('created');
        if (bound) {
          unwrap(await repo.bindClaimNotices('bot', thread, 'claim', notices));
          await conn.models.ThreadModeration.updateOne(
            { thread_id: thread },
            { $set: { 'claims.0.delivery_completed_at': null } },
          );
        }
        const restarted = new MongoThreadModerationRepo(conn);
        expect(unwrap(await restarted.createClaim('bot', thread, claim('early', 1_299_999)))).toBe(
          'duplicate',
        );
        const outcomes = (
          await Promise.all([
            restarted.createClaim('bot', thread, claim('retry-one', 1_300_000)),
            restarted.createClaim('bot', thread, claim('retry-two', 1_300_000)),
          ])
        ).map(unwrap);
        expect(outcomes.filter((value) => value === 'created')).toHaveLength(1);
        expect(outcomes.filter((value) => value === 'duplicate')).toHaveLength(1);
        expect(unwrap(await restarted.findClaim('bot', thread, 'claim'))?.status).toBe(
          'delivery_failed',
        );
        expect(
          unwrap(await restarted.completeClaimDelivery('bot', thread, 'claim', 1_300_001)),
        ).toBe(false);
      }
    });
  });

  it('requires timely completed delivery before approval and preserves completed pending requests', async () => {
    await fixture(async (repo, conn) => {
      unwrap(await repo.createClaim('bot', 'thread', claim()));
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 1_000_001))).toBe(
        false,
      );
      unwrap(await repo.bindClaimNotices('bot', 'thread', 'claim', notices));
      expect(unwrap(await decide(repo, true))).toBe(false);
      expect(unwrap(await decide(repo, false))).toBe(false);
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 1_300_000))).toBe(
        false,
      );
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 0))).toBe(false);
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 1_299_999))).toBe(
        true,
      );
      expect(unwrap(await repo.completeClaimDelivery('bot', 'thread', 'claim', 1_299_999))).toBe(
        false,
      );
      const restarted = new MongoThreadModerationRepo(conn);
      expect(
        unwrap(await restarted.findClaim('bot', 'thread', 'claim'))?.delivery_completed_at,
      ).toBe(1_299_999);
      expect(unwrap(await restarted.createClaim('bot', 'thread', claim('retry', 1_300_000)))).toBe(
        'duplicate',
      );
      expect(unwrap(await decide(restarted, true, 'claim', 1_300_001))).toBe(true);
      unwrap(await repo.createClaim('bot', 'other', { ...claim(), expires_at: 1_000_001 }));
      unwrap(await repo.bindClaimNotices('bot', 'other', 'claim', notices));
      expect(unwrap(await repo.completeClaimDelivery('bot', 'other', 'claim', 1_000_001))).toBe(
        false,
      );
    });
  });

  it('translates persistence failures for every new operation', async () => {
    await fixture(async (repo, conn) => {
      const failed = (): never => {
        throw new Error('unavailable');
      };
      const exists = vi.spyOn(conn.models.ThreadModeration, 'exists');
      exists.mockImplementationOnce(failed);
      expect((await repo.isManager('bot', 'thread', 'user')).ok).toBe(false);
      const find = vi.spyOn(conn.models.ThreadModeration, 'findOne');
      find.mockImplementationOnce(failed);
      expect((await repo.listManagers('bot', 'thread')).ok).toBe(false);
      const findMany = vi.spyOn(conn.models.ThreadModeration, 'find');
      findMany.mockImplementationOnce(failed);
      expect((await repo.listGuildManagers('bot')).ok).toBe(false);
      find.mockImplementationOnce(failed);
      expect((await repo.findClaim('bot', 'thread', 'claim')).ok).toBe(false);
      find.mockImplementationOnce(failed);
      expect((await decide(repo, true)).ok).toBe(false);
      const update = vi.spyOn(conn.models.ThreadModeration, 'updateOne');
      for (const operation of [
        () => repo.setManager('bot', 'thread', 'user', 'admin', true, 1),
        () => repo.createClaim('bot', 'thread', claim()),
        () => repo.bindClaimNotices('bot', 'thread', 'claim', notices),
        () => repo.failClaimDelivery('bot', 'thread', 'claim'),
        () => repo.completeClaimDelivery('bot', 'thread', 'claim', 1_000_001),
      ]) {
        update.mockImplementationOnce(failed);
        expect((await operation()).ok).toBe(false);
      }
      expect((await repo.createClaim('bot', 'thread', { ...claim(), status: 'approved' })).ok).toBe(
        false,
      );
    });
  });
});
