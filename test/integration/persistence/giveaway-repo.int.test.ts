import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import { isErr, unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoGiveawayRepo,
  type GiveawayInput,
} from '../../../src/persistence/repositories/giveaway.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');
const buildRepo = async (m: StaticConnectionManager): Promise<MongoGiveawayRepo> =>
  new MongoGiveawayRepo(await m.getConnection(guildId));

const input = (overrides: Partial<GiveawayInput> & { message_id: string }): GiveawayInput => ({
  winner_num: 1,
  prize: 'mug',
  end_time: Date.now() + 60_000,
  channel_id: 'c1',
  prize_owner_id: 'u1',
  participants: [],
  ...overrides,
});

describe('MongoGiveawayRepo (integration)', () => {
  it('create persists and findByMessageId returns the same doc', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ message_id: 'm1' })));
      expect(unwrap(await repo.findByMessageId('m1'))?.prize).toBe('mug');
    });
  });

  it('findByMessageId returns ok(undefined) for an unknown message id', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.findByMessageId('missing'))).toBeUndefined();
    });
  });

  it('listAll returns every giveaway (used by reboot job)', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ message_id: 'm1' })));
      unwrap(await repo.create(input({ message_id: 'm2', prize: 'hat' })));
      const all = unwrap(await repo.listAll());
      expect(all.map((d) => d.message_id).sort()).toEqual(['m1', 'm2']);
    });
  });

  it('deleteByMessageId removes and returns true / false correctly', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ message_id: 'm1' })));
      expect(unwrap(await repo.deleteByMessageId('m1'))).toBe(true);
      expect(unwrap(await repo.deleteByMessageId('m1'))).toBe(false);
    });
  });

  it('listAll resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await withClosedConnection(
      async (connection) =>
        new MongoGiveawayRepo(await new StaticConnectionManager(connection).getConnection(guildId)),
    );

    const result = await repo.listAll();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoGiveawayRepo.listAll');
    }
  });
});
