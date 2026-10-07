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

const requireMongoUri = (): string => {
  const uri = process.env.INTEGRATION_MONGO_URI;
  if (uri === undefined) {
    throw new Error('INTEGRATION_MONGO_URI not set; vitest globalSetup did not run');
  }
  return uri;
};

const guildId = asGuildId('111111111111111111');

describe('MongoConnectionManager (integration)', () => {
  it('dedupes concurrent getConnection() calls for the same guild', async () => {
    // memory-server URIs already include a trailing slash + db name.
    // Reuse the URI directly; appending a guild id is the production
    // path and is exercised in the unit test for buildGuildMongoUri.
    const baseUri = requireMongoUri().replace(/[^/]*$/, '');
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
    }
  });

  it('opens distinct connections for distinct guild ids', async () => {
    const baseUri = requireMongoUri().replace(/[^/]*$/, '');
    const mgr = new MongoConnectionManager(baseUri);
    try {
      const a = await mgr.getConnection(guildId);
      const b = await mgr.getConnection(asGuildId('222222222222222222'));
      expect(a.connection).not.toBe(b.connection);
    } finally {
      await mgr.closeAll();
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
    const baseUri = requireMongoUri().replace(/[^/]*$/, '');
    const tolerateGuildId = asGuildId('333333333333333333');
    const seedUri = buildGuildMongoUri(baseUri, tolerateGuildId);

    const seed = await mongoose.createConnection(seedUri).asPromise();
    try {
      await seed.collection('messages').insertMany([
        { messageId: 'collide', timestamp: 1 },
        { messageId: 'collide', timestamp: 2 },
      ]);
      await seed.collection('userapisettings').insertMany([{ userId: 'same' }, { userId: 'same' }]);
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

    // Cleanup the seed data so a re-run of this suite stays clean.
    const cleanup = await mongoose.createConnection(seedUri).asPromise();
    try {
      await cleanup.dropDatabase();
    } finally {
      await cleanup.close();
    }
  });
});
