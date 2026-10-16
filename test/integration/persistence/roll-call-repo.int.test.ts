/** `MongoRollCallRepo`: only called members check in, once, and only while open. */
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoRollCallRepo } from '../../../src/persistence/repositories/roll-call.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999996');

describe('MongoRollCallRepo (integration)', () => {
  it('checks in called members once and stops at close', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoRollCallRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(
        await repo.create({
          message_id: 'm1',
          channel_id: 'c1',
          creator_id: 'caller',
          persona: 'Bot',
          targets: ['u1', 'u2'],
        }),
      );
      expect(unwrap(await repo.checkIn('m1', 'u1'))).toBe(true);
      expect(unwrap(await repo.checkIn('m1', 'u1'))).toBe(false);
      expect(unwrap(await repo.checkIn('m1', 'stranger'))).toBe(false);
      expect(unwrap(await repo.listOpen())).toHaveLength(1);

      expect(unwrap(await repo.close('m1', new Date(Date.now() + 1000)))).toBe(true);
      expect(unwrap(await repo.close('m1', new Date()))).toBe(false);
      expect(unwrap(await repo.checkIn('m1', 'u2'))).toBe(false);
      expect(unwrap(await repo.findByMessageId('m1'))?.present).toEqual(['u1']);
      expect(unwrap(await repo.listOpen())).toHaveLength(0);
    });
  });
});
