/**
 * Suite for `archive-legacy-isolate` against an in-memory MongoDB:
 * collection classification, the dry-run report, the real rename / drop /
 * schedule-disable pass, the owner lease, partial failure, and every
 * refusal precondition.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DROPPED_EXACT,
  ISOLATED_COLLECTIONS,
  isolationActionFor,
  type IsolationAction,
} from './collections';
import { createIsolateCommand, isolateOptionsSchema } from './isolate';
import {
  collectionNames,
  nextGuildId,
  runContext,
  startTestMongo,
  withGuildDb,
  type StringIdDocument,
  type TestMongo,
} from './test-support';

const NOW = 1_790_000_000_000;
const TS = String(NOW);
const OTHER_TS = '1780000000000';
const command = createIsolateCommand(() => NOW);
let mongoServer: TestMongo | undefined;

const server = (): TestMongo => {
  if (mongoServer === undefined) throw new Error('in-memory MongoDB did not start');
  return mongoServer;
};

beforeAll(async () => {
  mongoServer = await startTestMongo();
}, 120_000);
afterAll(async () => {
  await mongoServer?.stop();
});

const SCHEDULE = {
  _id: 'current',
  enabled: true,
  nextRunAt: 5,
  running: true,
  revision: 3,
  pauseVersion: 1,
};

/** A representative legacy guild: data, control metadata, schedule, an empty lease table, and bystanders. */
const seedLegacyGuild = async (guildId: string): Promise<void> =>
  withGuildDb(server().uri, guildId, async (db) => {
    await db.collection('messages').insertMany([{ messageId: '1' }, { messageId: '2' }]);
    await db.collection('archive_revisions').insertOne({ messageId: '1' });
    await db.collection('archive_reactions').insertOne({ messageId: '1', userIds: ['7'] });
    await db.collection('fetches').insertOne({ channelID: '10', lastMessageID: '' });
    await db.collection('archive_jobs').insertOne({ jobId: 'j' });
    await db.collection('archive_repair_operations').insertOne({ op: 1 });
    await db.collection('archive_control_confirmations').insertOne({ c: 1 });
    await db.collection<StringIdDocument>('archive_storage_usage').insertOne({
      _id: 'host',
      usedBytes: 1,
    });
    await db.collection<StringIdDocument>('archive_gateway_continuity').insertOne({
      _id: 'current',
      fullRequired: false,
    });
    await db.collection<StringIdDocument>('archive_schedule').insertOne({ ...SCHEDULE });
    await db.createCollection('archive_leases');
    await db.collection('archive_future_thing').insertOne({ x: 1 });
    await db.collection('todos').insertOne({ t: 1 });
  });

const readSchedule = (guildId: string) =>
  withGuildDb(server().uri, guildId, (db) =>
    db.collection<StringIdDocument>('archive_schedule').findOne({ _id: 'current' }),
  );
const leaseCount = (guildId: string) =>
  withGuildDb(server().uri, guildId, (db) => db.collection('archive_leases').countDocuments({}));

interface IsolateReport {
  legacyTimestamp: string;
  guilds: {
    status: string;
    reason?: string;
    error?: string;
    resumeWith?: unknown;
    collections?: { name: string; action: string; done?: boolean }[];
  }[];
}
const firstGuild = (report: unknown) => (report as IsolateReport).guilds[0];

describe('archive-legacy-isolate / options and classification', () => {
  it('defaults to a dry run that starts a new legacy set', () => {
    expect(isolateOptionsSchema.parse({})).toEqual({ dry_run: true, legacy_timestamp: null });
    expect(isolateOptionsSchema.safeParse({ legacy_timestamp: 'abc' }).success).toBe(false);
  });

  const table: readonly (readonly [string, IsolationAction | null])[] = [
    ...ISOLATED_COLLECTIONS.map((name) => [name, 'rename'] as const),
    ...[...DROPPED_EXACT].map((name) => [name, 'drop'] as const),
    ['archive_repair_runs', 'drop'],
    ['archive_repair_operations', 'drop'],
    ['archive_control_confirmations', 'drop'],
    ['archive_control_deletions', 'drop'],
    ['archive_bulk_deletions', 'drop'],
    ['archive_bulk_deletion_items', 'drop'],
    ['archive_gateway_continuity', 'drop'],
    ['archive_storage_usage', 'drop'],
    ['archive_schedule', 'disable-schedule'],
    ['archive_leases', 'keep'],
    ['archive_unknown', 'keep-unclassified'],
    ['todos', null],
    ['legacy_1_messages', null],
  ];
  it.each(table)('maps %s to %s', (name, action) => {
    expect(isolationActionFor(name)).toBe(action);
  });

  it('isolates exactly the legacy data collections', () => {
    expect([...ISOLATED_COLLECTIONS].sort()).toEqual([
      'archive_channels',
      'archive_inbox',
      'archive_quarantine',
      'archive_reactions',
      'archive_revisions',
      'fetches',
      'messages',
    ]);
  });
});

describe('archive-legacy-isolate / runs', () => {
  it('reports counts and planned actions in a dry run without changing anything', async () => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);
    const before = await collectionNames(server().uri, guildId);

    const result = await command.execute({}, runContext(server().uri, [guildId]));

    expect(result.exitCode).toBe(0);
    expect(result.summaryLine).toBe(`PASS (legacy_timestamp ${TS})`);
    expect((result.report as IsolateReport).legacyTimestamp).toBe(TS);
    const guild = firstGuild(result.report);
    expect(guild?.status).toBe('would-isolate');
    expect(guild?.collections).toContainEqual(
      expect.objectContaining({
        name: 'messages',
        action: 'rename',
        target: `legacy_${TS}_messages`,
        documentCount: 2,
      }),
    );
    expect(guild?.collections).toContainEqual(
      expect.objectContaining({ name: 'archive_jobs', action: 'drop', documentCount: 1 }),
    );
    expect(guild?.collections).toContainEqual(
      expect.objectContaining({ name: 'archive_gateway_continuity', action: 'drop' }),
    );
    for (const name of ['archive_control_confirmations', 'archive_storage_usage'])
      expect(guild?.collections).toContainEqual(
        expect.objectContaining({ name, action: 'drop', documentCount: 1 }),
      );
    expect(guild?.collections).toContainEqual(
      expect.objectContaining({ name: 'archive_future_thing', action: 'keep-unclassified' }),
    );
    expect(guild?.collections).not.toContainEqual(expect.objectContaining({ name: 'todos' }));
    expect(await collectionNames(server().uri, guildId)).toEqual(before);
    expect(await readSchedule(guildId)).toEqual(SCHEDULE);
    expect(
      await withGuildDb(server().uri, guildId, (db) => db.collection('messages').countDocuments()),
    ).toBe(2);
    expect(await leaseCount(guildId)).toBe(0);
  });

  it('renames data aside, drops control metadata, disables the schedule, and releases its lease', async () => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);

    const result = await command.execute({ dry_run: false }, runContext(server().uri, [guildId]));

    expect(result.exitCode).toBe(0);
    const steps = firstGuild(result.report)?.collections?.filter((c) => c.done !== undefined);
    // Six seeded collections renamed or dropped, plus the schedule, lease and new metadata.
    expect(steps).toHaveLength(10);
    expect(steps?.every((c) => c.done === true)).toBe(true);
    expect(await collectionNames(server().uri, guildId)).toEqual([
      'archive_future_thing',
      'archive_leases',
      'archive_schedule',
      `legacy_${TS}_archive_reactions`,
      `legacy_${TS}_archive_revisions`,
      `legacy_${TS}_fetches`,
      `legacy_${TS}_messages`,
      'todos',
    ]);
    expect(await readSchedule(guildId)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      running: false,
      revision: 4,
      pauseVersion: 2,
    });
    expect(await leaseCount(guildId)).toBe(0);
  });

  it('reports partial progress and the timestamp to resume with when a step fails', async () => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);
    // An existing rename target makes `archive_revisions` fail after `archive_reactions` moved.
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection(`legacy_${TS}_archive_revisions`).insertOne({ messageId: '0' }),
    );

    const result = await command.execute(
      { dry_run: false, legacy_timestamp: TS },
      runContext(server().uri, [guildId]),
    );

    expect(result.exitCode).toBe(1);
    expect(result.summaryLine).toMatch(/^FAIL \(1 guild\(s\) refused, partial, or errored/);
    const guild = firstGuild(result.report);
    expect(guild).toMatchObject({ status: 'partial', resumeWith: { legacy_timestamp: TS } });
    const done = Object.fromEntries((guild?.collections ?? []).map((c) => [c.name, c.done]));
    expect(done).toMatchObject({
      archive_schedule: true,
      archive_reactions: true,
      archive_revisions: false,
      messages: false,
      archive_jobs: false,
    });
    expect(await collectionNames(server().uri, guildId)).toContain('messages');
    expect(await leaseCount(guildId)).toBe(0);
  });
});

describe('archive-legacy-isolate / refusals', () => {
  const expectRefused = async (
    guildId: string,
    options: Record<string, unknown>,
    reason: string | RegExp,
    isolate = command,
  ): Promise<void> => {
    const before = await collectionNames(server().uri, guildId);
    const result = await isolate.execute(options, runContext(server().uri, [guildId]));
    expect(result.exitCode).toBe(1);
    expect(firstGuild(result.report)).toMatchObject({ status: 'refused' });
    expect(firstGuild(result.report)?.reason).toMatch(reason);
    expect(await collectionNames(server().uri, guildId)).toEqual(before);
  };

  it.each([
    ['a dry run', {}],
    ['a real run', { dry_run: false }],
  ])('refuses %s while msg-archive holds the owner lease', async (_name, options) => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);
    await withGuildDb(server().uri, guildId, (db) =>
      db
        .collection<StringIdDocument>('archive_leases')
        .insertOne({ _id: 'owner', key: 'owner', ownerId: 'host:1:abc', acquiredAt: 1 }),
    );
    await expectRefused(guildId, options, 'host:1:abc');
    // The other process's lease is left untouched.
    expect(await leaseCount(guildId)).toBe(1);
  });

  it('names a malformed lease as an unknown owner', async () => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection('archive_leases').insertOne({ key: 'owner' }),
    );
    await expectRefused(guildId, { dry_run: false }, '<unknown owner>');
  });

  it('refuses a second legacy set but resumes an interrupted one', async () => {
    const guildId = nextGuildId();
    await seedLegacyGuild(guildId);
    // Simulate an isolation that stopped after renaming `archive_revisions` only.
    await withGuildDb(server().uri, guildId, (db) =>
      db.renameCollection('archive_revisions', `legacy_${TS}_archive_revisions`),
    );

    await expectRefused(
      guildId,
      { dry_run: false },
      TS,
      createIsolateCommand(() => NOW + 1),
    );
    await expectRefused(guildId, { dry_run: false, legacy_timestamp: OTHER_TS }, TS);

    const resumed = await command.execute(
      { dry_run: false, legacy_timestamp: TS },
      runContext(server().uri, [guildId]),
    );
    expect(resumed.exitCode).toBe(0);
    const names = await collectionNames(server().uri, guildId);
    expect(names).toContain(`legacy_${TS}_messages`);
    expect(names).not.toContain('archive_jobs');
  });

  it('refuses to move a rebuilt archive aside', async () => {
    const guildId = nextGuildId();
    await withGuildDb(server().uri, guildId, async (db) => {
      await db.collection<StringIdDocument>('messages').insertOne({ _id: '1', schemaVersion: 3 });
      await db.createCollection('archive_leases');
    });
    await expectRefused(guildId, { dry_run: false }, 'new-format');
    expect(await leaseCount(guildId)).toBe(0);
  });
});
