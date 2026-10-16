/** `MongoBugTicketRepo`: numbers run per bot, and open tickets exclude closed ones. */
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoBugTicketRepo } from '../../../src/persistence/repositories/bug-ticket.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999995');
const input = (bot_id: string, created_at: number) => ({
  bot_id,
  reporter_id: 'reporter',
  type: 'bug' as const,
  title: 'It broke',
  created_at,
});

describe('MongoBugTicketRepo (integration)', () => {
  it('numbers tickets per bot, even when created concurrently', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoBugTicketRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      const created = await Promise.all([1, 2, 3].map((at) => repo.createNumbered(input('a', at))));
      expect(created.map((result) => unwrap(result).number).sort()).toEqual([1, 2, 3]);
      expect(unwrap(await repo.createNumbered(input('b', 4))).number).toBe(1);
    });
  });

  it('lists open tickets newest first and tracks the latest report', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoBugTicketRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(await repo.createNumbered(input('a', 10)));
      unwrap(await repo.createNumbered(input('a', 20)));
      unwrap(await repo.setThread('a', 2, 'thread-2'));
      unwrap(await repo.setStatus('a', 1, 'closed', { at: 30, by: 'admin' }));

      const open = unwrap(await repo.listOpenByReporter('a', 'reporter'));
      expect(open.map((ticket) => ticket.number)).toEqual([2]);
      expect(unwrap(await repo.lastCreatedAt('a', 'reporter'))).toBe(20);
      expect(unwrap(await repo.findByThread('thread-2'))?.number).toBe(2);
      expect(unwrap(await repo.findByNumber('a', 1))?.closed_by).toBe('admin');
    });
  });
});
