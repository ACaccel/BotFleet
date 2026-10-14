/**
 * `DbInspectService` against a fake repository: target validation, filters
 * and sorts, paging sessions, Discord names, suggestions, caching, and an
 * audit line per read that never carries results.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DbInspectService,
  type DiscordDirectory,
} from '../../../../src/application/db-inspect/service';
import { DatabaseError, DbInspectError } from '../../../../src/core/errors';
import type { Logger } from '../../../../src/core/logger';
import { err, ok } from '../../../../src/core/result';
import type {
  DbInspectRepo,
  InspectDocument,
} from '../../../../src/persistence/repositories/db-inspect.repo';

const GUILD = '111111111111111111';
const OTHER = '222222222222222222';
const USER_A = '300000000000000001';
const USER_B = '300000000000000002';

interface Harness {
  readonly service: DbInspectService;
  readonly repo: { [K in keyof DbInspectRepo]: ReturnType<typeof vi.fn> };
  readonly repoFactory: ReturnType<typeof vi.fn>;
  readonly listGuildDatabases: ReturnType<typeof vi.fn>;
  readonly directory: { [K in keyof DiscordDirectory]: ReturnType<typeof vi.fn> };
  readonly audits: { readonly bindings: unknown; readonly message: string }[];
  readonly clock: { now: number };
}

const harness = (documents: readonly InspectDocument[] = []): Harness => {
  const repo = {
    listCollections: vi.fn(async () =>
      ok([
        { name: 'replies', estimatedCount: documents.length },
        { name: 'messages', estimatedCount: 5 },
        { name: 'legacy', estimatedCount: 2 },
      ]),
    ),
    collectionStats: vi.fn(async () =>
      ok([
        { name: 'replies', count: 1, size: 10, storageSize: 100, indexCount: 1, indexSize: 4 },
        { name: 'legacy', count: 2, size: 20, storageSize: 300, indexCount: 1, indexSize: 4 },
      ]),
    ),
    indexes: vi.fn(async (collection: string) =>
      ok(
        collection === 'messages'
          ? [
              { name: '_id_', keys: ['_id'] },
              { name: 'createdTimestamp_1', keys: ['createdTimestamp'] },
            ]
          : [
              { name: '_id_', keys: ['_id'] },
              { name: 'input_1', keys: ['input'] },
            ],
      ),
    ),
    find: vi.fn(async () => ok(documents)),
    count: vi.fn(async () => ok({ count: documents.length, capped: false })),
    findById: vi.fn(async () => ok(documents[0])),
    topValues: vi.fn(async () => ok([] as { value: unknown; count: number }[])),
  };
  const audits: { bindings: unknown; message: string }[] = [];
  const makeLogger = (bindings: unknown): Logger =>
    ({
      info: (message: string) => audits.push({ bindings, message }),
      child: (next: unknown) => makeLogger(next),
    }) as unknown as Logger;
  const directory = {
    guildName: vi.fn((id: string) => (id === GUILD ? 'Home' : undefined)),
    channelName: vi.fn((id: string) => `channel-${id.slice(-1)}`),
    roleName: vi.fn((_guild: string, id: string) => `role-${id.slice(-1)}`),
    userName: vi.fn(async (id: string, fetch: boolean) =>
      fetch ? `user-${id.slice(-1)}` : undefined,
    ),
  };
  const listGuildDatabases = vi.fn(async () => [
    { name: OTHER, sizeOnDisk: 5 },
    { name: GUILD, sizeOnDisk: 10 },
  ]);
  const repoFactory = vi.fn(() => repo as unknown as DbInspectRepo);
  const clock = { now: 0 };
  const service = new DbInspectService({
    listGuildDatabases,
    repo: repoFactory,
    directory,
    logger: makeLogger({}),
    now: () => clock.now,
  });
  return { service, repo, repoFactory, listGuildDatabases, directory, audits, clock };
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return error instanceof DbInspectError ? error.code : (error as Error).name;
  }
  return undefined;
};

const replies = (count: number): InspectDocument[] =>
  Array.from({ length: count }, (_, i) => ({
    _id: `id-${i}`,
    input: `in-${i}`,
    reply: `out-${i}`,
    created_by: i % 2 === 0 ? USER_A : USER_B,
  }));

describe('guilds and collections', () => {
  it('lists guild databases, named guilds first', async () => {
    const { service } = harness();
    expect(await service.listGuilds()).toEqual([
      { id: GUILD, name: 'Home', sizeOnDisk: 10 },
      { id: OTHER, sizeOnDisk: 5 },
    ]);
  });

  it('caches the database list briefly', async () => {
    const h = harness();
    await h.service.listGuilds();
    await h.service.listCollections(GUILD);
    expect(h.listGuildDatabases).toHaveBeenCalledTimes(1);
    h.clock.now = 30_001;
    await h.service.listGuilds();
    expect(h.listGuildDatabases).toHaveBeenCalledTimes(2);
  });

  it('rejects a database that does not exist', async () => {
    const { service } = harness();
    expect(await codeOf(() => service.listCollections('999'))).toBe('DB_INSPECT_UNKNOWN_GUILD');
  });

  it('marks registered collections', async () => {
    const { service } = harness();
    expect(await service.listCollections(GUILD)).toEqual([
      { name: 'replies', estimatedCount: 0, registered: true },
      { name: 'messages', estimatedCount: 5, registered: true },
      { name: 'legacy', estimatedCount: 2, registered: false },
    ]);
  });

  it('orders statistics by storage size and audits the read', async () => {
    const h = harness();
    const stats = await h.service.stats('admin', GUILD);
    expect(stats.map((entry) => [entry.name, entry.registered])).toEqual([
      ['legacy', false],
      ['replies', true],
    ]);
    expect(h.audits).toEqual([
      {
        bindings: { dbInspect: { userId: 'admin', database: GUILD } },
        message: 'ops:db_inspect.read | /db stats',
      },
    ]);
  });

  it('surfaces repository failures as their database error', async () => {
    const h = harness();
    h.repo.collectionStats.mockResolvedValueOnce(
      err(
        new DatabaseError({
          code: 'DATABASE_QUERY_TIMEOUT',
          messageKey: 'k',
          context: { operation: 'x' },
        }),
      ),
    );
    expect(await codeOf(() => h.service.stats('admin', GUILD))).toBe('DatabaseError');
  });
});

describe('describe', () => {
  it('describes a schema-backed collection with its newest document', async () => {
    const h = harness(replies(1));
    const description = await h.service.describe('admin', GUILD, 'replies');
    expect(description).toMatchObject({
      name: 'replies',
      registered: true,
      inferred: false,
      estimatedCount: 1,
      sample: replies(1)[0],
    });
    // The live index on `input` marks a field the schema does not index.
    expect(description.fields.find((field) => field.path === 'input')?.indexed).toBe(true);
    expect(h.repo.find).toHaveBeenCalledWith({
      collection: 'replies',
      sort: { field: '_id', direction: -1 },
      skip: 0,
      limit: 1,
    });
  });

  it('infers fields of an unregistered collection from documents', async () => {
    const h = harness([{ _id: 'a', kind: 'x' }]);
    const description = await h.service.describe('admin', GUILD, 'legacy');
    expect(description.registered).toBe(false);
    expect(description.inferred).toBe(true);
    expect(description.fields.map((field) => field.path)).toEqual(['_id', 'kind']);
  });

  it('reports an empty collection without a sample', async () => {
    const h = harness();
    expect((await h.service.describe('admin', GUILD, 'replies')).sample).toBeUndefined();
  });

  it('rejects a collection the database lacks', async () => {
    const { service } = harness();
    expect(await codeOf(() => service.describe('admin', GUILD, 'nope'))).toBe(
      'DB_INSPECT_UNKNOWN_COLLECTION',
    );
  });
});

describe('query and paging', () => {
  it('runs the default query newest first and names summary users', async () => {
    const h = harness(replies(3));
    const page = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'replies',
      filter: {},
    });
    expect(page).toMatchObject({
      database: GUILD,
      collection: 'replies',
      page: 0,
      pageCount: 1,
      total: { count: 3, capped: false },
      sort: { field: '_id', direction: -1 },
      unindexedFilter: false,
      summaryFields: ['input', 'reply', 'created_by'],
    });
    expect(page.condition).toBeUndefined();
    expect([...page.names]).toEqual([
      [USER_A, 'user-1'],
      [USER_B, 'user-2'],
    ]);
    expect(h.repo.count).toHaveBeenCalledWith('replies', undefined, 10_000);
  });

  it('passes a parsed filter and flags an unindexed field', async () => {
    const h = harness(replies(1));
    const page = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'replies',
      filter: { field: 'reply', operator: 'contains', value: 'out' },
    });
    const condition = { field: 'reply', operator: 'substring', value: 'out' };
    expect(page.condition).toEqual(condition);
    expect(page.unindexedFilter).toBe(true);
    expect(h.repo.find).toHaveBeenCalledWith(expect.objectContaining({ condition }));
    const audit = h.audits.at(-1);
    expect(audit?.message).toBe('ops:db_inspect.read | /db list');
    expect(audit?.bindings).toEqual({
      dbInspect: {
        userId: 'admin',
        database: GUILD,
        collection: 'replies',
        sort: '_id:desc',
        filter: 'reply substring out',
        matched: 1,
      },
    });
    expect(JSON.stringify(h.audits)).not.toContain('in-0');
  });

  it('does not flag a filter on an indexed field', async () => {
    const h = harness(replies(1));
    const page = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'replies',
      filter: { field: 'input', operator: 'eq', value: 'in-0' },
    });
    expect(page.unindexedFilter).toBe(false);
  });

  it('sorts only by _id or a leading index key', async () => {
    const h = harness();
    const page = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'messages',
      sort: 'createdTimestamp:asc',
      filter: {},
    });
    expect(page.sort).toEqual({ field: 'createdTimestamp', direction: 1 });
    expect(
      await codeOf(() =>
        h.service.query({
          userId: 'admin',
          database: GUILD,
          collection: 'messages',
          sort: 'content:desc',
          filter: {},
        }),
      ),
    ).toBe('DB_INSPECT_INVALID_SORT');
    expect(
      await codeOf(() =>
        h.service.query({
          userId: 'admin',
          database: GUILD,
          collection: 'messages',
          sort: 'garbage',
          filter: {},
        }),
      ),
    ).toBe('DB_INSPECT_INVALID_SORT');
  });

  it('pages within the reachable range and only for the session owner', async () => {
    const h = harness(replies(10));
    h.repo.count.mockResolvedValueOnce(ok({ count: 50_000, capped: true }));
    const first = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'replies',
      filter: {},
    });
    expect(first.pageCount).toBe(1_000);
    const last = await h.service.page(first.token, 5_000, 'admin');
    expect(last.page).toBe(999);
    expect(h.repo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 9_990, limit: 10 }),
    );
    expect((await h.service.page(first.token, -3, 'admin')).page).toBe(0);
    expect(await codeOf(() => h.service.page(first.token, 1, 'intruder'))).toBe(
      'DB_INSPECT_NOT_INVOKER',
    );
    expect(() => h.service.assertSession(first.token, 'admin')).not.toThrow();
    h.clock.now = 16 * 60 * 1000;
    expect(() => h.service.assertSession(first.token, 'admin')).toThrow(DbInspectError);
  });

  it('opens a row of the current page by index', async () => {
    const h = harness(replies(2));
    const page = await h.service.query({
      userId: 'admin',
      database: GUILD,
      collection: 'replies',
      filter: {},
    });
    const view = await h.service.documentAt(page.token, 1, 'admin');
    expect(h.repo.findById).toHaveBeenCalledWith('replies', 'id-1');
    expect(view.collection).toBe('replies');
    expect(await codeOf(() => h.service.documentAt(page.token, 7, 'admin'))).toBe(
      'DB_INSPECT_SESSION_EXPIRED',
    );
  });
});

describe('get', () => {
  it('returns a document with every referenced name', async () => {
    const h = harness([
      { _id: 'm1', author: { id: USER_A }, channelId: '400000000000000004', content: 'hi' },
    ]);
    const view = await h.service.get('admin', GUILD, 'messages', 'm1');
    expect(view.document['content']).toBe('hi');
    expect(view.names.get(USER_A)).toBe('user-1');
    expect(view.names.get('400000000000000004')).toBe('channel-4');
    expect(h.audits.at(-1)?.bindings).toEqual({
      dbInspect: { userId: 'admin', database: GUILD, collection: 'messages', id: 'm1' },
    });
  });

  it('names guild and role references', async () => {
    const h = harness([
      { _id: 'b1', source_guild_id: GUILD, reporter_id: USER_B },
      { _id: 't1', role_id: '500000000000000005' },
    ]);
    h.repo.listCollections.mockResolvedValue(
      ok([
        { name: 'bugtickets', estimatedCount: 1 },
        { name: 'temproles', estimatedCount: 1 },
      ]),
    );
    const ticket = await h.service.get('admin', GUILD, 'bugtickets', 'b1');
    expect(ticket.names.get(GUILD)).toBe('Home');
    h.repo.findById.mockResolvedValueOnce(ok({ _id: 't1', role_id: '500000000000000005' }));
    const role = await h.service.get('admin', GUILD, 'temproles', 't1');
    expect(role.names.get('500000000000000005')).toBe('role-5');
    expect(h.directory.roleName).toHaveBeenCalledWith(GUILD, '500000000000000005');
  });

  it('fetches at most ten uncached users per view', async () => {
    const participants = Array.from({ length: 12 }, (_, i) => `6000000000000000${10 + i}`);
    const h = harness([{ _id: 'g1', participants }]);
    h.repo.listCollections.mockResolvedValue(ok([{ name: 'giveaways', estimatedCount: 1 }]));
    const view = await h.service.get('admin', GUILD, 'giveaways', 'g1');
    expect(view.names.size).toBe(10);
    expect(h.directory.userName.mock.calls.filter(([, fetch]) => fetch === true)).toHaveLength(10);
  });

  it('rejects a missing document and an unknown collection', async () => {
    const h = harness();
    h.repo.findById.mockResolvedValueOnce(ok(undefined));
    expect(await codeOf(() => h.service.get('admin', GUILD, 'replies', 'x'))).toBe(
      'DB_INSPECT_NOT_FOUND',
    );
    expect(await codeOf(() => h.service.get('admin', GUILD, 'nope', 'x'))).toBe(
      'DB_INSPECT_UNKNOWN_COLLECTION',
    );
  });
});

describe('suggestions', () => {
  it('suggests guilds matching the typed text, current guild first', async () => {
    const { service } = harness();
    expect((await service.suggestGuilds('', OTHER)).map((guild) => guild.id)).toEqual([
      OTHER,
      GUILD,
    ]);
    expect((await service.suggestGuilds('hom', null)).map((guild) => guild.id)).toEqual([GUILD]);
    expect((await service.suggestGuilds('2222', null)).map((guild) => guild.id)).toEqual([OTHER]);
  });

  it('suggests collections and fields, indexed fields first', async () => {
    const h = harness();
    expect((await h.service.suggestCollections(GUILD, 'mess')).map((c) => c.name)).toEqual([
      'messages',
    ]);
    const fields = await h.service.suggestFields(GUILD, 'replies', '');
    expect(
      fields
        .slice(0, 2)
        .map((field) => field.path)
        .sort(),
    ).toEqual(['_id', 'input']);
    expect((await h.service.suggestFields(GUILD, 'replies', 'creat')).map((f) => f.path)).toEqual([
      'created_by',
    ]);
  });

  it('caches collection metadata for suggestions', async () => {
    const h = harness();
    await h.service.suggestFields(GUILD, 'replies', '');
    await h.service.suggestSorts(GUILD, 'replies');
    expect(h.repo.indexes).toHaveBeenCalledTimes(1);
    h.clock.now = 61_000;
    await h.service.suggestFields(GUILD, 'replies', '');
    expect(h.repo.indexes).toHaveBeenCalledTimes(2);
  });

  it('suggests operators for the chosen field, or all before one is chosen', async () => {
    const { service } = harness();
    expect(await service.suggestOperators(GUILD, 'replies', undefined)).toEqual([
      'eq',
      'contains',
      'gt',
      'lt',
      'exists',
    ]);
    expect(await service.suggestOperators(GUILD, 'messages', 'createdTimestamp')).toEqual([
      'eq',
      'gt',
      'lt',
      'exists',
    ]);
  });

  it('suggests _id and leading index keys in both directions', async () => {
    const { service } = harness();
    expect(await service.suggestSorts(GUILD, 'messages')).toEqual([
      { field: '_id', direction: -1 },
      { field: '_id', direction: 1 },
      { field: 'createdTimestamp', direction: -1 },
      { field: 'createdTimestamp', direction: 1 },
    ]);
  });

  it('suggests values by field type', async () => {
    const h = harness();
    h.repo.listCollections.mockResolvedValue(
      ok([
        { name: 'replies', estimatedCount: 1 },
        { name: 'bugtickets', estimatedCount: 1 },
        { name: 'messages', estimatedCount: 1 },
        { name: 'giveaways', estimatedCount: 1 },
      ]),
    );
    expect(await h.service.suggestValues(GUILD, 'replies', undefined, undefined, '')).toEqual([]);
    expect(await h.service.suggestValues(GUILD, 'replies', 'nope', undefined, '')).toEqual([]);
    expect(await h.service.suggestValues(GUILD, 'replies', 'input', 'exists', '')).toEqual([
      { label: 'true', value: 'true' },
      { label: 'false', value: 'false' },
    ]);
    expect(
      (await h.service.suggestValues(GUILD, 'bugtickets', 'status', 'eq', 'clo')).map(
        (entry) => entry.value,
      ),
    ).toEqual(['closed']);
    expect(await h.service.suggestValues(GUILD, 'messages', 'createdTimestamp', 'gt', '')).toEqual(
      [],
    );

    h.repo.topValues.mockResolvedValueOnce(
      ok([
        { value: USER_A, count: 3 },
        { value: 'x'.repeat(101), count: 1 },
        { value: '', count: 1 },
      ]),
    );
    expect(await h.service.suggestValues(GUILD, 'replies', 'created_by', 'eq', '3000')).toEqual([
      { label: `${USER_A}`, value: USER_A },
    ]);
    expect(h.repo.topValues).toHaveBeenLastCalledWith('replies', 'created_by', {
      unwind: false,
      limit: 25,
      prefix: '3000',
    });

    h.directory.userName.mockResolvedValueOnce('Alice');
    h.repo.topValues.mockResolvedValueOnce(ok([{ value: USER_A, count: 1 }]));
    expect(
      await h.service.suggestValues(GUILD, 'giveaways', 'participants', 'contains', ''),
    ).toEqual([{ label: `Alice (${USER_A})`, value: USER_A }]);
    expect(h.repo.topValues).toHaveBeenLastCalledWith('giveaways', 'participants', {
      unwind: true,
      limit: 25,
    });

    h.repo.topValues.mockResolvedValueOnce(ok([{ value: 3, count: 1 }]));
    await h.service.suggestValues(GUILD, 'giveaways', 'winner_num', 'eq', '3');
    expect(h.repo.topValues).toHaveBeenLastCalledWith('giveaways', 'winner_num', {
      unwind: false,
      limit: 25,
    });

    h.repo.topValues.mockResolvedValueOnce(
      err(
        new DatabaseError({
          code: 'DATABASE_QUERY_TIMEOUT',
          messageKey: 'k',
          context: { operation: 'x' },
        }),
      ),
    );
    expect(await h.service.suggestValues(GUILD, 'replies', 'input', 'eq', '')).toEqual([]);
  });

  it('suggests the newest IDs containing the typed text', async () => {
    const h = harness(replies(3));
    expect((await h.service.suggestIds(GUILD, 'replies', 'id-2')).map((entry) => entry.id)).toEqual(
      ['id-2'],
    );
    h.repo.find.mockResolvedValueOnce(
      err(
        new DatabaseError({
          code: 'DATABASE_QUERY_TIMEOUT',
          messageKey: 'k',
          context: { operation: 'x' },
        }),
      ),
    );
    expect(await h.service.suggestIds(GUILD, 'replies', '')).toEqual([]);
  });
});
