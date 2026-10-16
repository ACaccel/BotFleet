import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import { isErr, unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoTempRoleRepo,
  type TempRoleInput,
} from '../../../src/persistence/repositories/temp-role.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');
const buildRepo = async (m: StaticConnectionManager): Promise<MongoTempRoleRepo> =>
  new MongoTempRoleRepo(await m.getConnection(guildId));

const input = (overrides: Partial<TempRoleInput> & { role_id: string }): TempRoleInput => ({
  channel_id: 'c1',
  message_id: 'm1',
  creator_id: 'u1',
  role_name: 'Notify',
  expires_at: Date.now() + 60_000,
  ...overrides,
});

describe('MongoTempRoleRepo (integration)', () => {
  it('create persists and findByRoleId returns the same doc', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ role_id: 'r1' })));
      expect(unwrap(await repo.findByRoleId('r1'))?.role_name).toBe('Notify');
    });
  });

  it('findByRoleId returns ok(undefined) for an unknown role id', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.findByRoleId('missing'))).toBeUndefined();
    });
  });

  it('listAll returns every temp role (used by reboot job)', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ role_id: 'r1' })));
      unwrap(await repo.create(input({ role_id: 'r2', role_name: 'Other' })));
      const all = unwrap(await repo.listAll());
      expect(all.map((d) => d.role_id).sort()).toEqual(['r1', 'r2']);
    });
  });

  it('deleteByRoleId removes and returns true / false correctly', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ role_id: 'r1' })));
      expect(unwrap(await repo.deleteByRoleId('r1'))).toBe(true);
      expect(unwrap(await repo.deleteByRoleId('r1'))).toBe(false);
    });
  });

  it('listAll resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await withClosedConnection(
      async (connection) =>
        new MongoTempRoleRepo(await new StaticConnectionManager(connection).getConnection(guildId)),
    );

    const result = await repo.listAll();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoTempRoleRepo.listAll');
    }
  });
});
