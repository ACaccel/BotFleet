/**
 * Contract of the export's presence predicate with the real archive writer:
 * documents written by the archive message repository for a full message and for a
 * policy-limited interaction record count as present; a bare tombstone does
 * not.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asGuildId } from '../../../../src/core/ids';
import { normalizeMessage } from '../../../../src/core/archive/normalize';
import {
  ArchivePolicySchema,
  applyPolicyDecision,
  evaluatePolicy,
} from '../../../../src/core/archive/policy';
import { StaticConnectionManager } from '../../../../src/infra/mongo/connection-manager';
import { buildArchiveWriterRepos } from '../../../../src/persistence/repositories/archive-repos';

import { presentMessageIds } from './new-backup';
import { nextGuildId, startTestMongo, type TestMongo } from './test-support';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startTestMongo();
}, 60_000);
afterAll(async () => {
  await mongo.stop();
});

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  channel_id: '10',
  author: { id: '20', username: 'member' },
  content: 'hello',
  timestamp: '2024-01-01T00:00:00.000Z',
  ...extra,
});

describe('presentMessageIds against the archive writer', () => {
  it('counts full messages and interaction records, never bare tombstones', async () => {
    const guildId = nextGuildId();
    const connection = await mongoose.createConnection(`${mongo.uri}${guildId}`).asPromise();
    try {
      const conn = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = buildArchiveWriterRepos(conn).messages;
      await repo.persistSnapshot(normalizeMessage(raw('1'), { observedAt: 1 }));
      const reply = normalizeMessage(
        raw('2', {
          author: { id: '30', username: 'app', bot: true },
          application_id: '30',
          interaction_metadata: { id: '40', type: 2, user: { id: '20' } },
        }),
        { observedAt: 1 },
      );
      const decision = evaluatePolicy(reply, ArchivePolicySchema.parse({ guildIds: [guildId] }), {
        guildId,
      });
      if (!decision.admitted) throw new Error('interaction reply must be admitted');
      expect(decision.reason).toBe('interaction-record');
      await repo.persistSnapshot(applyPolicyDecision(reply, decision));
      await repo.tombstone('3', '10', 1);
      // A deleted message that was observed first keeps its content.
      await repo.persistSnapshot(normalizeMessage(raw('4'), { observedAt: 1 }));
      await repo.tombstone('4', '10', 2);
      if (connection.db === undefined) throw new Error('test connection has no db handle');
      expect(
        [...(await presentMessageIds(connection.db, ['1', '2', '3', '4', '5']))].sort(),
      ).toEqual(['1', '2', '4']);
    } finally {
      await connection.close();
    }
  });
});
