import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import { isErr, unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoUserApiSettingRepo,
  type UserApiSettingDefaults,
} from '../../../src/persistence/repositories/user-api-setting.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');
const buildRepo = async (m: StaticConnectionManager): Promise<MongoUserApiSettingRepo> =>
  new MongoUserApiSettingRepo(await m.getConnection(guildId));

const defaults: UserApiSettingDefaults = {
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 1,
  system_prompt: '',
  web_search: false,
};

describe('MongoUserApiSettingRepo (integration)', () => {
  it('findByUserId returns ok(undefined) when not whitelisted', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.findByUserId('u1'))).toBeUndefined();
    });
  });

  it('create whitelists a user with default settings', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      const created = unwrap(await repo.create('u1', defaults));
      expect(created.userId).toBe('u1');
      expect(created.provider).toBe('openai');
      expect(unwrap(await repo.findByUserId('u1'))?.model).toBe('gpt-4o');
    });
  });

  it('listAll returns every whitelist entry', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create('u1', defaults));
      unwrap(await repo.create('u2', defaults));
      expect(
        unwrap(await repo.listAll())
          .map((d) => d.userId)
          .sort(),
      ).toEqual(['u1', 'u2']);
    });
  });

  it('update applies a partial patch and returns true on match', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create('u1', defaults));
      expect(unwrap(await repo.update('u1', { model: 'gpt-5', temperature: 0.3 }))).toBe(true);
      const after = unwrap(await repo.findByUserId('u1'));
      expect(after?.model).toBe('gpt-5');
      expect(after?.temperature).toBe(0.3);
      expect(after?.provider).toBe('openai'); // unchanged
    });
  });

  it('update returns false when the user is not whitelisted', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.update('missing', { model: 'gpt-5' }))).toBe(false);
    });
  });

  it('deleteByUserId removes the entry and returns true / false correctly', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create('u1', defaults));
      expect(unwrap(await repo.deleteByUserId('u1'))).toBe(true);
      expect(unwrap(await repo.deleteByUserId('u1'))).toBe(false);
    });
  });

  it('findByUserId resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await withClosedConnection(
      async (connection) =>
        new MongoUserApiSettingRepo(
          await new StaticConnectionManager(connection).getConnection(guildId),
        ),
    );

    const result = await repo.findByUserId('u1');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoUserApiSettingRepo.findByUserId');
    }
  });
});
