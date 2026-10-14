/**
 * Integration smoke for `MongoConnectionManager`.
 *
 * Covers production-side paths the message-repo suite does not
 * exercise (it uses `StaticConnectionManager`):
 *   - In-flight dedupe via the `pending` map (two simultaneous
 *     `getConnection(g)` calls share one open).
 *   - Tolerance for `model.init()` failures: when an index build
 *     rejects (legacy duplicate data, missing `createIndex`
 *     permission, etc.) the manager logs the rejection but still
 *     returns a usable cached connection. Regression for the
 *     phase-7 hotfix that converted `Promise.all` -> `allSettled`
 *     after every DB command failed with "找不到資料庫" once a single
 *     model's init rejected.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import {
  MongoConnectionManager,
  buildGuildMongoUri,
} from '../../../src/infra/mongo/connection-manager';
import { integrationMongoBaseUri, uniqueGuildId } from '../helpers/mongo';

/**
 * The production manager names each guild's database after the guild
 * id, so these tests cannot use `withFreshConnection`. Unique ids plus
 * this cleanup give them the same isolation.
 */
const dropGuildDatabases = async (baseUri: string, guildIds: readonly string[]): Promise<void> => {
  for (const id of guildIds) {
    const connection = await mongoose.createConnection(buildGuildMongoUri(baseUri, id)).asPromise();
    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  }
};

describe('MongoConnectionManager (integration)', () => {
  it('dedupes concurrent getConnection() calls for the same guild', async () => {
    const baseUri = integrationMongoBaseUri();
    const guildId = asGuildId(uniqueGuildId());
    const mgr = new MongoConnectionManager(baseUri);
    try {
      const [a, b, c] = await Promise.all([
        mgr.getConnection(guildId),
        mgr.getConnection(guildId),
        mgr.getConnection(guildId),
      ]);
      expect(a.connection).toBe(b.connection);
      expect(b.connection).toBe(c.connection);
    } finally {
      await mgr.closeAll();
      await dropGuildDatabases(baseUri, [guildId]);
    }
  });

  it('opens distinct connections for distinct guild ids', async () => {
    const baseUri = integrationMongoBaseUri();
    const first = asGuildId(uniqueGuildId());
    const second = asGuildId(uniqueGuildId());
    const mgr = new MongoConnectionManager(baseUri);
    try {
      const a = await mgr.getConnection(first);
      const b = await mgr.getConnection(second);
      expect(a.connection).not.toBe(b.connection);
    } finally {
      await mgr.closeAll();
      await dropGuildDatabases(baseUri, [first, second]);
    }
  });

  it('retries then disables a guild whose Mongo URI is broken', async () => {
    // A deliberately broken base URI (unresolvable host) makes every
    // `getConnection` attempt fail with a transient
    // server-selection timeout. The manager retries with bounded
    // backoff, then — once the budget is spent — marks the guild
    // disabled with a generated traceId. A real cluster is not needed:
    // the failure happens before any handshake.
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    // Short serverSelectionTimeout keeps the test fast; 2 attempts with
    // a no-op sleep means the whole case is sub-second despite 2 real
    // (failed) connection attempts.
    const brokenUri = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200&';
    const mgr = new MongoConnectionManager(
      brokenUri,
      { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
      async () => {},
    );
    try {
      const brokenGuild = asGuildId('444444444444444444');
      await expect(mgr.getConnection(brokenGuild)).rejects.toBeInstanceOf(DatabaseError);

      const disabled = mgr.isDisabled(brokenGuild);
      expect(disabled).toBeDefined();
      expect(disabled?.traceId).toMatch(/^[0-9a-z]{6}$/);
      expect(disabled?.error).toBeInstanceOf(DatabaseError);

      // A disabled guild short-circuits — the next call rejects with
      // the exact same typed error and does not retry the cluster.
      await expect(mgr.getConnection(brokenGuild)).rejects.toBe(disabled?.error);
    } finally {
      process.stderr.write = stderrWrite;
      await mgr.closeAll();
    }
  });

  it('tolerates model.init() rejection and still returns a usable connection', async () => {
    // Non-archive models retain best-effort initialization. Archive readers
    // must not attempt to repair legacy duplicates or create archive indexes.
    const baseUri = integrationMongoBaseUri();
    const tolerateGuildId = asGuildId(uniqueGuildId());
    const seedUri = buildGuildMongoUri(baseUri, tolerateGuildId);

    try {
      const seed = await mongoose.createConnection(seedUri).asPromise();
      try {
        await seed.collection('messages').insertMany([
          { messageId: 'collide', timestamp: 1 },
          { messageId: 'collide', timestamp: 2 },
        ]);
        await seed
          .collection('userapisettings')
          .insertMany([{ userId: 'same' }, { userId: 'same' }]);
      } finally {
        await seed.close();
      }

      // Silence the operator-facing stderr line during the test run; it
      // is intentional in production but noisy in vitest output.
      const stderrWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;

      const mgr = new MongoConnectionManager(baseUri);
      try {
        const guildConn = await mgr.getConnection(tolerateGuildId);
        expect(guildConn.connection.readyState).toBe(1);
        // Models map is still wired even though the index for Message
        // is missing — repository code can still query/insert non-unique
        // workflows.
        expect(guildConn.models.Reply).toBeDefined();

        // Subsequent `getConnection` hits the cache and returns the same
        // entry (no re-attempt, no second stderr line).
        const reuse = await mgr.getConnection(tolerateGuildId);
        expect(reuse).toBe(guildConn);

        // Operator MUST see WHICH model failed: a bare "model.init() failed"
        // line would force them to grep the codebase to learn whether it
        // was Message, UserApiSetting, or something else. The phase-7
        // hotfix bakes the model name into the line.
        const failureLine = captured.find((line) => line.includes('model.init() failed'));
        expect(failureLine).toBeDefined();
        expect(failureLine).toMatch(/model\.init\(\) failed for UserApiSetting on guild /);
        expect(captured.some((line) => line.includes('failed for Message'))).toBe(false);
        expect(await guildConn.models.Message.collection.countDocuments()).toBe(2);
        expect(
          (await guildConn.models.Message.collection.indexes()).map((index) => index.name),
        ).toEqual(['_id_']);
        expect(guildConn.archiveOwner).toBeUndefined();
      } finally {
        process.stderr.write = stderrWrite;
        await mgr.closeAll();
      }
    } finally {
      await dropGuildDatabases(baseUri, [tolerateGuildId]);
    }
  });
});
