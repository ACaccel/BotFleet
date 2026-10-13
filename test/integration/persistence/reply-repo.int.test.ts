/**
 * Integration coverage for `MongoReplyRepo`. One case per public method
 * plus the "absent" branches for `findById` (unknown id -> ok(undefined))
 * and `deleteById` (no document removed -> ok(false)) — both observable
 * contract returns that would silently regress without an assertion.
 *
 * Every repo method returns `Result<T, DatabaseError>`. The
 * happy-path cases unwrap with the test-only `unwrap`; the closed-
 * connection case asserts the `err(DatabaseError)` channel directly.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import { isErr, unwrap } from '../../../src/core/result';
import {
  StaticConnectionManager,
  buildGuildMongoUri,
} from '../../../src/infra/mongo/connection-manager';
import { MongoReplyRepo } from '../../../src/persistence/repositories/reply.repo';
import { withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');

describe('MongoReplyRepo (integration)', () => {
  it('create persists a pair and returns the stored doc', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      const doc = unwrap(await repo.create('hello', 'world', 'u-creator'));
      expect(doc.input).toBe('hello');
      expect(doc.reply).toBe('world');
      expect(doc.created_by).toBe('u-creator');
    });
  });

  it('listAll returns every pair in the guild', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(await repo.create('a', '1', 'u-creator'));
      unwrap(await repo.create('b', '2', 'u-creator'));
      const all = unwrap(await repo.listAll());
      expect(all.map((doc) => doc.input).sort()).toEqual(['a', 'b']);
    });
  });

  it('findExactPair returns matching pairs only', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(await repo.create('hi', 'there', 'u-creator'));
      unwrap(await repo.create('hi', 'world', 'u-creator')); // same input, different reply
      const exact = unwrap(await repo.findExactPair('hi', 'there'));
      expect(exact).toHaveLength(1);
      expect(exact[0]?.reply).toBe('there');
    });
  });

  it('findByInput returns every reply registered for one input', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      unwrap(await repo.create('q', 'a1', 'u-creator'));
      unwrap(await repo.create('q', 'a2', 'u-creator'));
      unwrap(await repo.create('other', 'noise', 'u-creator'));
      const got = unwrap(await repo.findByInput('q'));
      expect(got.map((d) => d.reply).sort()).toEqual(['a1', 'a2']);
    });
  });

  it('findById returns the stored doc when present', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      const created = unwrap(await repo.create('k', 'v', 'u-creator'));
      const found = unwrap(await repo.findById(created._id.toString()));
      expect(found?.reply).toBe('v');
    });
  });

  it('findById returns ok(undefined) for an unknown id', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      // Valid-shape ObjectId that has not been persisted.
      expect(unwrap(await repo.findById('507f1f77bcf86cd799439011'))).toBeUndefined();
    });
  });

  it('deleteById removes a stored doc and returns true', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      const created = unwrap(await repo.create('k', 'v', 'u-creator'));
      expect(unwrap(await repo.deleteById(created._id.toString()))).toBe(true);
      expect(unwrap(await repo.findById(created._id.toString()))).toBeUndefined();
    });
  });

  it('deleteById returns false when nothing was removed', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoReplyRepo(
        await new StaticConnectionManager(connection).getConnection(guildId),
      );
      expect(unwrap(await repo.deleteById('507f1f77bcf86cd799439011'))).toBe(false);
    });
  });

  it('findByInput resolves to err(DatabaseError) when the connection is closed', async () => {
    const baseUri = (() => {
      const uri = process.env.INTEGRATION_MONGO_URI;
      if (uri === undefined) throw new Error('INTEGRATION_MONGO_URI not set');
      return uri.replace(/[^/]*$/, '');
    })();
    const connection = await mongoose
      .createConnection(buildGuildMongoUri(baseUri, guildId))
      .asPromise();
    const repo = new MongoReplyRepo(
      await new StaticConnectionManager(connection).getConnection(guildId),
    );
    await connection.close();

    const result = await repo.findByInput('anything');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoReplyRepo.findByInput');
    }
  });
});
