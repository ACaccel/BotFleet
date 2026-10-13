/** `MongoAiUsageRepo` counts a member's requests per window across restarts. */
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoAiUsageRepo } from '../../../src/persistence/repositories/ai-usage.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999998');

describe('MongoAiUsageRepo (integration)', () => {
  it('counts only the member and window asked for, oldest first', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoAiUsageRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(await repo.record('u1', new Date(1_000)));
      unwrap(await repo.record('u1', new Date(5_000)));
      unwrap(await repo.record('u1', new Date(9_000)));
      unwrap(await repo.record('u2', new Date(9_000)));

      const window = unwrap(await repo.windowSince('u1', new Date(4_000)));
      expect(window.count).toBe(2);
      expect(window.oldest?.getTime()).toBe(5_000);
      expect(unwrap(await repo.windowSince('u3', new Date(0)))).toEqual({ count: 0 });
    });
  });
});
