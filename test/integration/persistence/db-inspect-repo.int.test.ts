/**
 * Integration suite for the read-only `/db` repository against a real
 * MongoDB: collection and index listing, every filter operator, paging,
 * counting with a cap, `_id` lookup by string or ObjectId, value
 * frequencies, and the contract that operational failures come back as
 * `err(DatabaseError)` while unsafe field names (programmer errors) throw.
 */
import mongoose, { type Connection, type mongo } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { DatabaseError } from '../../../src/core/errors';
import { unwrap } from '../../../src/core/result';
import {
  MongoDbInspectRepo,
  escapeRegex,
  filterFor,
  type InspectQuery,
} from '../../../src/persistence/repositories/db-inspect.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const MAX_TIME_MS = 5_000;

const nativeDb = (connection: Connection): mongo.Db => {
  if (connection.db === undefined) throw new Error('connection has no native db');
  return connection.db;
};

const repoOn = (connection: Connection): MongoDbInspectRepo =>
  new MongoDbInspectRepo(nativeDb(connection), MAX_TIME_MS);

const query = (overrides: Partial<InspectQuery> = {}): InspectQuery => ({
  collection: 'items',
  sort: { field: '_id', direction: 1 },
  skip: 0,
  limit: 50,
  ...overrides,
});

const ids = (documents: readonly { readonly _id?: unknown }[]): unknown[] =>
  documents.map((document) => document._id);

describe('MongoDbInspectRepo collections', () => {
  it('lists real collections by name with counts, without views or system collections', async () => {
    await withFreshConnection(async (connection) => {
      const db = nativeDb(connection);
      await db.collection('zeta').insertMany([{ a: 1 }, { a: 2 }, { a: 3 }]);
      await db.collection('alpha').insertOne({ a: 1 });
      await db.createCollection('empty');
      await db.createCollection('alpha_view', { viewOn: 'alpha', pipeline: [] });
      await db.collection('system.js').insertOne({ _id: 'fn' as unknown as mongo.ObjectId });

      const listed = unwrap(await repoOn(connection).listCollections());
      expect(listed).toEqual([
        { name: 'alpha', estimatedCount: 1 },
        { name: 'empty', estimatedCount: 0 },
        { name: 'zeta', estimatedCount: 3 },
      ]);
    });
  });

  it('returns an empty list for a database without collections', async () => {
    await withFreshConnection(async (connection) => {
      expect(unwrap(await repoOn(connection).listCollections())).toEqual([]);
    });
  });

  it('reports storage statistics per collection', async () => {
    await withFreshConnection(async (connection) => {
      const db = nativeDb(connection);
      await db.collection('items').createIndex({ name: 1 });
      await db.collection('items').insertMany([{ name: 'a' }, { name: 'b' }]);
      await db.createCollection('items_view', { viewOn: 'items', pipeline: [] });

      const stats = unwrap(await repoOn(connection).collectionStats());
      expect(stats.map((entry) => entry.name)).toEqual(['items']);
      const [items] = stats;
      expect(items?.count).toBe(2);
      expect(items?.size).toBeGreaterThan(0);
      expect(items?.storageSize).toBeGreaterThan(0);
      // The default _id index plus the one created above.
      expect(items?.indexCount).toBe(2);
      expect(items?.indexSize).toBeGreaterThan(0);
    });
  });

  it('lists the key paths of every index', async () => {
    await withFreshConnection(async (connection) => {
      const items = nativeDb(connection).collection('items');
      await items.insertOne({ a: 1 });
      await items.createIndex({ channelId: 1, createdTimestamp: -1 }, { name: 'by_channel' });

      const indexes = unwrap(await repoOn(connection).indexes('items'));
      expect(indexes).toContainEqual({ name: '_id_', keys: ['_id'] });
      expect(indexes).toContainEqual({
        name: 'by_channel',
        keys: ['channelId', 'createdTimestamp'],
      });
    });
  });

  it('answers an index listing of a missing collection with an error result', async () => {
    await withFreshConnection(async (connection) => {
      const result = await repoOn(connection).indexes('no_such_collection');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DatabaseError);
        expect(result.error.context.operation).toBe('MongoDbInspectRepo.indexes');
      }
    });
  });
});

describe('MongoDbInspectRepo.find', () => {
  const seed = async (connection: Connection): Promise<void> => {
    await nativeDb(connection)
      .collection('items')
      .insertMany([
        { _id: 'a' as never, name: 'abc', score: 10, tags: ['red', 'blue'], flag: true },
        { _id: 'b' as never, name: 'a.c', score: 20, tags: ['green'] },
        { _id: 'c' as never, name: 'ABCD', score: 30, tags: [], flag: false },
        { _id: 'd' as never, name: 'x(y)', score: 40, nested: { deep: 'v' } },
      ]);
  };

  it('matches equality on strings, numbers and array elements', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const repo = repoOn(connection);
      const run = async (field: string, value: string | number) =>
        ids(unwrap(await repo.find(query({ condition: { field, operator: 'eq', value } }))));
      expect(await run('name', 'abc')).toEqual(['a']);
      expect(await run('score', 20)).toEqual(['b']);
      expect(await run('tags', 'blue')).toEqual(['a']);
      expect(await run('nested.deep', 'v')).toEqual(['d']);
    });
  });

  it('matches substrings case-insensitively and treats metacharacters literally', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const repo = repoOn(connection);
      const run = async (value: string) =>
        ids(
          unwrap(
            await repo.find(query({ condition: { field: 'name', operator: 'substring', value } })),
          ),
        );
      expect(await run('BC')).toEqual(['a', 'c']);
      expect(await run('a.c')).toEqual(['b']);
      expect(await run('(y)')).toEqual(['d']);
      expect(await run('.*')).toEqual([]);
    });
  });

  it('compares with gt and lt', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const repo = repoOn(connection);
      const gt = unwrap(
        await repo.find(query({ condition: { field: 'score', operator: 'gt', value: 20 } })),
      );
      const lt = unwrap(
        await repo.find(query({ condition: { field: 'score', operator: 'lt', value: 20 } })),
      );
      expect(ids(gt)).toEqual(['c', 'd']);
      expect(ids(lt)).toEqual(['a']);
    });
  });

  it('filters on whether a field is present', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const repo = repoOn(connection);
      const present = unwrap(
        await repo.find(query({ condition: { field: 'flag', operator: 'exists', value: true } })),
      );
      const absent = unwrap(
        await repo.find(query({ condition: { field: 'flag', operator: 'exists', value: false } })),
      );
      expect(ids(present)).toEqual(['a', 'c']);
      expect(ids(absent)).toEqual(['b', 'd']);
    });
  });

  it('matches an ObjectId given by its hex string', async () => {
    await withFreshConnection(async (connection) => {
      const owner = new mongoose.mongo.ObjectId();
      await nativeDb(connection)
        .collection('items')
        .insertMany([{ owner }, { owner: new mongoose.mongo.ObjectId() }, { owner: 'text' }]);
      const found = unwrap(
        await repoOn(connection).find(
          query({
            sort: { field: 'owner', direction: 1 },
            condition: { field: 'owner', operator: 'eq', value: { objectId: owner.toHexString() } },
          }),
        ),
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.owner).toEqual(owner);
    });
  });

  it('sorts in both directions and pages with skip and limit', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const repo = repoOn(connection);
      const descending = unwrap(
        await repo.find(query({ sort: { field: 'score', direction: -1 } })),
      );
      expect(ids(descending)).toEqual(['d', 'c', 'b', 'a']);
      const page = unwrap(
        await repo.find(query({ sort: { field: 'score', direction: -1 }, skip: 1, limit: 2 })),
      );
      expect(ids(page)).toEqual(['c', 'b']);
    });
  });

  it('returns an empty page for a collection that does not exist', async () => {
    await withFreshConnection(async (connection) => {
      expect(unwrap(await repoOn(connection).find(query({ collection: 'nothing' })))).toEqual([]);
    });
  });
});

describe('MongoDbInspectRepo.count', () => {
  it('estimates the whole collection when there is no condition', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection)
        .collection('items')
        .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
      expect(unwrap(await repoOn(connection).count('items', undefined, 1))).toEqual({
        count: 3,
        capped: false,
      });
    });
  });

  it('counts matches exactly below the cap', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection)
        .collection('items')
        .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
      const result = await repoOn(connection).count(
        'items',
        { field: 'n', operator: 'gt', value: 1 },
        10,
      );
      expect(unwrap(result)).toEqual({ count: 2, capped: false });
    });
  });

  it('does not flag a count equal to the cap as capped', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection)
        .collection('items')
        .insertMany([{ n: 1 }, { n: 2 }]);
      const result = await repoOn(connection).count(
        'items',
        { field: 'n', operator: 'gt', value: 0 },
        2,
      );
      expect(unwrap(result)).toEqual({ count: 2, capped: false });
    });
  });

  it('clamps to the cap and flags more matches than were counted', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection)
        .collection('items')
        .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
      const result = await repoOn(connection).count(
        'items',
        { field: 'n', operator: 'gt', value: 0 },
        2,
      );
      expect(unwrap(result)).toEqual({ count: 2, capped: true });
    });
  });
});

describe('MongoDbInspectRepo.findById', () => {
  it('finds a document whose _id is a string', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection)
        .collection('items')
        .insertOne({ _id: '123456789012345678' as never, name: 'snowflake' });
      const found = unwrap(await repoOn(connection).findById('items', '123456789012345678'));
      expect(found?.name).toBe('snowflake');
    });
  });

  it('finds a document whose _id is an ObjectId from its 24-hex string', async () => {
    await withFreshConnection(async (connection) => {
      const _id = new mongoose.mongo.ObjectId();
      await nativeDb(connection).collection('items').insertOne({ _id, name: 'oid' });
      const found = unwrap(await repoOn(connection).findById('items', _id.toHexString()));
      expect(found?.name).toBe('oid');
    });
  });

  it('finds a string _id that happens to look like an ObjectId', async () => {
    await withFreshConnection(async (connection) => {
      const hex = new mongoose.mongo.ObjectId().toHexString();
      await nativeDb(connection)
        .collection('items')
        .insertOne({ _id: hex as never, name: 'stringly' });
      const found = unwrap(await repoOn(connection).findById('items', hex));
      expect(found?.name).toBe('stringly');
    });
  });

  it('resolves to undefined when no document has that id', async () => {
    await withFreshConnection(async (connection) => {
      await nativeDb(connection).collection('items').insertOne({ name: 'other' });
      const repo = repoOn(connection);
      expect(unwrap(await repo.findById('items', 'missing'))).toBeUndefined();
      expect(unwrap(await repo.findById('items', 'f'.repeat(24)))).toBeUndefined();
    });
  });
});

describe('MongoDbInspectRepo.topValues', () => {
  const seed = async (connection: Connection): Promise<void> => {
    await nativeDb(connection)
      .collection('items')
      .insertMany([
        { kind: 'apple', tags: ['x', 'y'] },
        { kind: 'apple', tags: ['x'] },
        { kind: 'apple', tags: ['x', 'z'] },
        { kind: 'avocado', tags: ['y'] },
        { kind: 'avocado' },
        { kind: 'banana', tags: ['y'] },
        { kind: null },
        { other: 1 },
      ]);
  };

  it('orders values by frequency and skips missing and null values', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const top = unwrap(
        await repoOn(connection).topValues('items', 'kind', { unwind: false, limit: 10 }),
      );
      expect(top).toEqual([
        { value: 'apple', count: 3 },
        { value: 'avocado', count: 2 },
        { value: 'banana', count: 1 },
      ]);
    });
  });

  it('limits the number of values', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const top = unwrap(
        await repoOn(connection).topValues('items', 'kind', { unwind: false, limit: 2 }),
      );
      expect(top.map((entry) => entry.value)).toEqual(['apple', 'avocado']);
    });
  });

  it('keeps only string values starting with the prefix, literally', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      await nativeDb(connection).collection('items').insertOne({ kind: 'a.x' });
      const repo = repoOn(connection);
      const prefixed = unwrap(
        await repo.topValues('items', 'kind', { prefix: 'av', unwind: false, limit: 10 }),
      );
      expect(prefixed).toEqual([{ value: 'avocado', count: 2 }]);
      const metacharacter = unwrap(
        await repo.topValues('items', 'kind', { prefix: 'a.', unwind: false, limit: 10 }),
      );
      expect(metacharacter).toEqual([{ value: 'a.x', count: 1 }]);
    });
  });

  it('treats an empty prefix as no prefix', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const top = unwrap(
        await repoOn(connection).topValues('items', 'kind', {
          prefix: '',
          unwind: false,
          limit: 1,
        }),
      );
      expect(top).toEqual([{ value: 'apple', count: 3 }]);
    });
  });

  it('counts array elements individually when asked to unwind', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection);
      const top = unwrap(
        await repoOn(connection).topValues('items', 'tags', { unwind: true, limit: 10 }),
      );
      // x and y tie at 3, so their relative order is unspecified.
      expect(top.slice(0, 2)).toEqual(
        expect.arrayContaining([
          { value: 'x', count: 3 },
          { value: 'y', count: 3 },
        ]),
      );
      expect(top[2]).toEqual({ value: 'z', count: 1 });
      expect(top).toHaveLength(3);
    });
  });
});

describe('MongoDbInspectRepo failures', () => {
  it('returns err(DatabaseError) from every operation on a closed connection', async () => {
    const repo = await withClosedConnection(async (connection) => repoOn(connection));
    const results = {
      listCollections: await repo.listCollections(),
      collectionStats: await repo.collectionStats(),
      indexes: await repo.indexes('items'),
      find: await repo.find(query()),
      count: await repo.count('items', { field: 'n', operator: 'eq', value: 1 }, 5),
      countEstimate: await repo.count('items', undefined, 5),
      findById: await repo.findById('items', 'id'),
      topValues: await repo.topValues('items', 'n', { unwind: false, limit: 5 }),
    };
    for (const [operation, result] of Object.entries(results)) {
      expect(result.ok, operation).toBe(false);
      if (!result.ok) expect(result.error, operation).toBeInstanceOf(DatabaseError);
    }
    const failed = results.find;
    if (!failed.ok) expect(failed.error.context.operation).toBe('MongoDbInspectRepo.find');
  });

  it('throws a TypeError for an unsafe field instead of returning a result', async () => {
    await withFreshConnection(async (connection) => {
      const repo = repoOn(connection);
      const unsafe = ['$where', 'a.$b', 'a..b', '', 'a b'];
      for (const field of unsafe) {
        await expect(
          repo.find(query({ condition: { field, operator: 'eq', value: 1 } })),
        ).rejects.toThrow(TypeError);
        await expect(repo.find(query({ sort: { field, direction: 1 } }))).rejects.toThrow(
          TypeError,
        );
        await expect(repo.count('items', { field, operator: 'eq', value: 1 }, 5)).rejects.toThrow(
          TypeError,
        );
        await expect(repo.topValues('items', field, { unwind: false, limit: 5 })).rejects.toThrow(
          TypeError,
        );
        expect(() => filterFor({ field, operator: 'eq', value: 1 })).toThrow(TypeError);
      }
    });
  });
});

describe('filterFor', () => {
  it('is an empty filter without a condition', () => {
    expect(filterFor(undefined)).toEqual({});
  });

  it('builds a literal filter for each operator', () => {
    expect(filterFor({ field: 'a.b', operator: 'eq', value: 'x' })).toEqual({ 'a.b': 'x' });
    expect(filterFor({ field: 'n', operator: 'gt', value: 1 })).toEqual({ n: { $gt: 1 } });
    expect(filterFor({ field: 'n', operator: 'lt', value: 1 })).toEqual({ n: { $lt: 1 } });
    expect(filterFor({ field: 'n', operator: 'exists', value: true })).toEqual({
      n: { $exists: true },
    });
    expect(filterFor({ field: 'n', operator: 'exists', value: false })).toEqual({
      n: { $exists: false },
    });
    expect(filterFor({ field: 'n', operator: 'eq', value: new Date(0) })).toEqual({
      n: new Date(0),
    });
  });

  it('escapes a substring into a case-insensitive literal pattern', () => {
    expect(filterFor({ field: 'n', operator: 'substring', value: 'a.c(1)' })).toEqual({
      n: { $regex: 'a\\.c\\(1\\)', $options: 'i' },
    });
    expect(escapeRegex('^$.*+?()[]{}|\\')).toBe('\\^\\$\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\\\');
  });

  it('turns an objectId value into a driver ObjectId', () => {
    const hex = 'AaBbCcDdEeFf001122334455';
    const filter = filterFor({ field: 'o', operator: 'eq', value: { objectId: hex } });
    expect(filter.o).toBeInstanceOf(mongoose.mongo.ObjectId);
    expect((filter.o as mongo.ObjectId).toHexString()).toBe(hex.toLowerCase());
  });

  it('rejects an objectId value that is not 24 hex digits', () => {
    for (const objectId of ['abc', 'g'.repeat(24), 'a'.repeat(25)]) {
      expect(() => filterFor({ field: 'o', operator: 'eq', value: { objectId } })).toThrow(
        TypeError,
      );
    }
  });

  it('rejects a substring condition with a non-string value', () => {
    expect(() => filterFor({ field: 'n', operator: 'substring', value: 5 })).toThrow(TypeError);
    expect(() =>
      filterFor({ field: 'n', operator: 'substring', value: { objectId: 'a'.repeat(24) } }),
    ).toThrow(TypeError);
  });
});
