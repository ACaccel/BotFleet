/**
 * Suite for `archive-legacy-export` against an in-memory MongoDB and the
 * real `zip` / `unzip` binaries: preconditions, classification by the
 * new channel access state, tombstones, related-record and inbox export,
 * the manifest's legacy collection inventory, the written archive
 * (permissions, type-preserving EJSON, cleanup), and the failure paths.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { mongo } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createZipTools, type ZipTools } from '../../framework/zip-tools';

import { createExportCommand, exportOptionsSchema } from './export';
import {
  nextGuildId,
  runContext,
  startTestMongo,
  withGuildDb,
  type StringIdDocument,
  type TestMongo,
} from './test-support';

const run = promisify(execFile);
const TS = '1790000000000';
const AFTER = Number(TS) + 1;
const tools = createZipTools();
const command = createExportCommand(tools, () => new Date(0));
let mongoServer: TestMongo | undefined;
let outputDir: string;

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
beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'archive-legacy-export-'));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

const legacy = (name: string): string => `legacy_${TS}_${name}`;
const createdAt = new Date('2024-01-02T03:04:05.000Z');

const seedJobs = (guildId: string, jobs: readonly Record<string, unknown>[]): Promise<unknown> =>
  withGuildDb(server().uri, guildId, (db) => db.collection('archive_jobs').insertMany([...jobs]));

/**
 * New backup: channels 10 readable, 11 denied, 12 deleted, 13 unknown (14 unrecorded); message 1
 * rebuilt with content, message 2 only a tombstone. Legacy: one message per channel, a duplicate of
 * message 2 and a rebuilt message in quarantine, cursor evidence without a message ID, revisions and
 * reactions for exported and rebuilt messages, three inbox events, and fetch checkpoints.
 */
const seedRebuild = async (guildId: string, completedJob = true): Promise<void> => {
  if (completedJob) {
    await seedJobs(guildId, [
      { jobId: 'pre-isolation', command: 'full-backup', status: 'complete', finishedAt: 1 },
      {
        jobId: 'old',
        command: 'full-backup',
        status: 'complete',
        finishedAt: AFTER,
        result: { cutoff: 100 },
      },
      {
        jobId: 'new',
        command: 'full-backup',
        status: 'complete',
        finishedAt: AFTER + 1,
        result: { cutoff: 200 },
      },
      { jobId: 'running', command: 'full-backup', status: 'running', finishedAt: AFTER + 2 },
    ]);
  }
  await withGuildDb(server().uri, guildId, async (db) => {
    await db.collection('archive_channels').insertMany([
      { channelId: '10', access: 'readable' },
      { channelId: '11', access: 'denied' },
      { channelId: '12', access: 'deleted' },
      { channelId: '13', access: 'unknown' },
    ]);
    await db.collection<StringIdDocument>('messages').insertMany([
      { _id: '1', schemaVersion: 3, channelId: '10', author: { id: '9' }, content: 'kept' },
      { _id: '2', schemaVersion: 3, channelId: '10', deletedAt: 5, observedAt: 5 },
    ]);
    await db.collection(legacy('messages')).insertMany([
      { messageId: '1', channelId: '10', channelName: 'general' },
      { messageId: '2', channelId: '10', channelName: 'general', createdAt, n: 5 },
      { messageId: '3', channelId: '11', channelName: 'secret' },
      { messageId: '4', channelId: '12', channelName: 'gone' },
      { messageId: '5', channelId: '13', channelName: 'maybe' },
      { messageId: '6', channelId: '14', channelName: '' },
      { channelId: '10', channelName: 'general' },
    ]);
    await db.collection(legacy('archive_quarantine')).insertMany([
      {
        messageId: '2',
        reason: 'duplicate',
        snapshot: { messageId: '2', channelId: '10', channelName: 'general' },
      },
      { messageId: '1', reason: 'duplicate', snapshot: { messageId: '1', channelId: '10' } },
      {
        sourceCollection: 'fetches',
        reason: 'invalid-channel-cursor',
        snapshot: { channelID: 'x' },
      },
    ]);
    await db.collection(legacy('archive_revisions')).insertMany([
      { messageId: '2', versionObservationId: 'a', snapshot: {} },
      { messageId: '2', versionObservationId: 'b', snapshot: {} },
      { messageId: '1', versionObservationId: 'c', snapshot: {} },
    ]);
    await db.collection(legacy('archive_reactions')).insertMany([
      { messageId: '4', emojiKey: 'x', userIds: ['7'], chunk: 0, generation: 'g' },
      { messageId: '1', emojiKey: 'x', userIds: ['7'], chunk: 0, generation: 'g' },
    ]);
    await db.collection(legacy('archive_inbox')).insertMany([
      { eventId: 'e1', kind: 'snapshot', messageId: '8', state: 'pending' },
      { eventId: 'e2', kind: 'delete', messageId: '9', state: 'processing' },
      { eventId: 'e3', kind: 'snapshot', messageId: '10', state: 'complete' },
    ]);
    await db.collection(legacy('fetches')).insertMany([{ channelID: '10' }, { channelID: '11' }]);
  });
};

interface GuildReport {
  status: string;
  reason?: string;
  error?: string;
  forced?: boolean;
  zipPath?: string;
  stagingDir?: string;
  warnings?: string[];
  newBackup?: unknown;
  legacyCollections?: { name: string; documentCount: number; handling: string }[];
  scan?: { scanned: Record<string, number>; inNewBackup: number };
  categories?: Record<string, Record<string, number>>;
  files?: { path: string; category: string; channelName: string | null; records: number }[];
  verification?: { ok: boolean; errors: string[]; zipPath: string };
}
const guildReport = (report: unknown): GuildReport =>
  (report as { guilds: GuildReport[] }).guilds[0] as GuildReport;

const options = (overrides: Record<string, unknown> = {}) => ({
  legacy_timestamp: TS,
  output_dir: outputDir,
  batch_size: 2,
  ...overrides,
});
const zipFor = (guildId: string): string =>
  path.join(outputDir, `archive-legacy-${guildId}-${TS}.zip`);
const counts = (
  messages: number,
  quarantine: number,
  revisions: number,
  reactions: number,
  inbox = 0,
) => ({
  messages,
  archive_quarantine: quarantine,
  archive_revisions: revisions,
  archive_reactions: reactions,
  archive_inbox: inbox,
});

describe('archive-legacy-export / options', () => {
  it('defaults to a dry run that honours the full-backup precondition', () => {
    expect(exportOptionsSchema.parse({ legacy_timestamp: TS })).toEqual({
      dry_run: true,
      legacy_timestamp: TS,
      force: false,
      output_dir: null,
      batch_size: 1000,
    });
    expect(exportOptionsSchema.safeParse({}).success).toBe(false);
  });

  it('fails fast before connecting when zip is missing', async () => {
    const missing = createExportCommand(
      createZipTools({ zip: 'botfleet-no-such-zip', unzip: 'unzip' }),
    );
    await expect(
      missing.execute(options(), runContext(server().uri, [nextGuildId()])),
    ).rejects.toThrow(/not found on PATH/);
  });

  it.each([
    ['inside the repository', path.resolve(__dirname, 'exports'), /inside the repository/],
    ['with a wildcard character', path.join(tmpdir(), 'exp*'), /must not contain/],
  ])('rejects an output_dir %s before connecting', async (_name, dir, error) => {
    await expect(
      command.execute(options({ output_dir: dir }), runContext(server().uri, [nextGuildId()])),
    ).rejects.toThrow(error);
  });
});

describe('archive-legacy-export / preconditions', () => {
  it('refuses without a full backup completed after the isolation unless forced', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId, false);
    await seedJobs(guildId, [
      { jobId: 'before', command: 'full-backup', status: 'complete', finishedAt: Number(TS) - 1 },
      { jobId: 'other', command: 'backfill', status: 'complete', finishedAt: AFTER },
    ]);

    const refused = await command.execute(options(), runContext(server().uri, [guildId]));
    expect(refused.exitCode).toBe(1);
    expect(refused.summaryLine).toBe('FAIL (1 guild(s) refused, unverified, or errored)');
    expect(guildReport(refused.report)).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('after the isolation'),
    });

    const forced = await command.execute(
      options({ force: true }),
      runContext(server().uri, [guildId]),
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.summaryLine).toBe('PASS');
    expect(guildReport(forced.report)).toMatchObject({
      status: 'would-export',
      forced: true,
      newBackup: null,
    });
  });

  it('falls back to the cutoff in the job options', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId, false);
    await seedJobs(guildId, [
      {
        _id: 'job-doc',
        command: 'full-backup',
        status: 'complete',
        finishedAt: AFTER,
        options: { cutoff: 7 },
      },
    ]);
    const result = await command.execute(options(), runContext(server().uri, [guildId]));
    expect(guildReport(result.report).newBackup).toEqual({
      jobId: 'job-doc',
      finishedAt: AFTER,
      cutoff: 7,
    });
  });

  it('refuses when the legacy set does not exist and names the sets present', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    const result = await command.execute(
      options({ legacy_timestamp: '1' }),
      runContext(server().uri, [guildId]),
    );
    expect(result.exitCode).toBe(1);
    expect(guildReport(result.report).reason).toContain(`legacy sets present: ${TS}`);
  });

  it('refuses a legacy set holding a collection isolation never creates', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection(legacy('archive_jobs')).insertOne({}),
    );
    const result = await command.execute(options(), runContext(server().uri, [guildId]));
    expect(guildReport(result.report)).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining(legacy('archive_jobs')),
    });
  });
});

describe('archive-legacy-export / classification', () => {
  it('counts missing records per category in a dry run without writing', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);

    const result = await command.execute(options(), runContext(server().uri, [guildId]));

    expect(result.exitCode).toBe(0);
    const report = guildReport(result.report);
    expect(report.status).toBe('would-export');
    expect(report.newBackup).toEqual({ jobId: 'new', finishedAt: AFTER + 1, cutoff: 200 });
    // Message 1 is rebuilt with content (legacy and quarantine copies skipped); message 2 is only a tombstone.
    expect(report.scan).toMatchObject({
      scanned: { messages: 7, archive_quarantine: 3, archive_inbox: 2 },
      inNewBackup: 2,
    });
    expect(report.categories).toEqual({
      'message-missing': counts(1, 1, 2, 0),
      'channel-inaccessible': counts(3, 0, 0, 0),
      'channel-deleted': counts(1, 0, 0, 1),
      unattributed: counts(1, 1, 0, 0),
      'inbox-pending': counts(0, 0, 0, 0, 2),
    });
    expect(report.files?.map((f) => [f.path, f.channelName, f.records])).toEqual([
      ['channel-deleted/12.json', 'gone', 2],
      ['channel-inaccessible/11.json', 'secret', 1],
      ['channel-inaccessible/13.json', 'maybe', 1],
      ['channel-inaccessible/14.json', null, 1],
      ['inbox/pending.json', null, 2],
      ['message-missing/10.json', 'general', 4],
      ['unattributed.json', null, 2],
    ]);
    expect(report.legacyCollections).toEqual([
      {
        name: legacy('archive_inbox'),
        source: 'archive_inbox',
        documentCount: 3,
        handling: 'exported',
      },
      {
        name: legacy('archive_quarantine'),
        source: 'archive_quarantine',
        documentCount: 3,
        handling: 'compared-against-new-backup',
      },
      {
        name: legacy('archive_reactions'),
        source: 'archive_reactions',
        documentCount: 2,
        handling: 'compared-against-new-backup',
      },
      {
        name: legacy('archive_revisions'),
        source: 'archive_revisions',
        documentCount: 3,
        handling: 'compared-against-new-backup',
      },
      {
        name: legacy('fetches'),
        source: 'fetches',
        documentCount: 2,
        handling: 'dropped-by-policy',
      },
      {
        name: legacy('messages'),
        source: 'messages',
        documentCount: 7,
        handling: 'compared-against-new-backup',
      },
    ]);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('exports without optional sources and leaves them out of the inventory', async () => {
    const guildId = nextGuildId();
    await seedJobs(guildId, [
      { jobId: 'j', command: 'full-backup', status: 'complete', finishedAt: AFTER },
    ]);
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection(legacy('messages')).insertOne({ messageId: '3', channelId: '11' }),
    );
    const result = await command.execute(options(), runContext(server().uri, [guildId]));
    const report = guildReport(result.report);
    expect(report.status).toBe('would-export');
    expect(report.legacyCollections?.map((c) => c.name)).toEqual([legacy('messages')]);
    expect(report.categories?.['channel-inaccessible']).toEqual(counts(1, 0, 0, 0));
  });

  it('does not refuse a dry run when the archive already exists', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    await writeFile(zipFor(guildId), 'keep me');
    const result = await command.execute(options(), runContext(server().uri, [guildId]));
    expect(guildReport(result.report).status).toBe('would-export');
  });
});

describe('archive-legacy-export / archive', () => {
  it('writes a verified 0600 archive, preserves types, and removes its staging directory', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);

    const result = await command.execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );

    expect(result.exitCode).toBe(0);
    const report = guildReport(result.report);
    const zipPath = zipFor(guildId);
    expect(report).toMatchObject({
      status: 'exported',
      zipPath,
      warnings: [],
      verification: { ok: true, errors: [], zipPath },
    });
    expect(await readdir(outputDir)).toEqual([path.basename(zipPath)]);
    expect((await stat(zipPath)).mode & 0o777).toBe(0o600);

    const manifest = JSON.parse((await run('unzip', ['-p', zipPath, 'manifest.json'])).stdout) as {
      guildId: string;
      legacyTimestamp: string;
      files: unknown[];
      legacyCollections: unknown[];
    };
    expect(manifest).toMatchObject({
      guildId,
      legacyTimestamp: TS,
      newBackup: { jobId: 'new', cutoff: 200 },
      forced: false,
    });
    expect(manifest.files).toHaveLength(7);
    expect(manifest.legacyCollections).toHaveLength(6);

    const text = (await run('unzip', ['-p', zipPath, 'message-missing/10.json'])).stdout;
    expect(text).toContain('{"$numberInt":"5"}');
    const channel = mongo.BSON.EJSON.parse(text, { relaxed: false }) as {
      collection: string;
      messageId: string | null;
      document: Record<string, unknown>;
    }[];
    expect(channel.map((r) => [r.collection, r.messageId])).toEqual([
      ['messages', '2'],
      ['archive_revisions', '2'],
      ['archive_revisions', '2'],
      ['archive_quarantine', '2'],
    ]);
    expect(channel[0]?.document['createdAt']).toEqual(createdAt);
    expect(channel[0]?.document['_id']).toBeInstanceOf(mongo.ObjectId);

    const inbox = mongo.BSON.EJSON.parse(
      (await run('unzip', ['-p', zipPath, 'inbox/pending.json'])).stdout,
    ) as { document: { eventId: string } }[];
    expect(inbox.map((r) => r.document.eventId)).toEqual(['e1', 'e2']);
  });

  it('refuses to overwrite an existing archive', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    await writeFile(zipFor(guildId), 'keep me');
    const result = await command.execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );
    expect(result.exitCode).toBe(1);
    expect(guildReport(result.report).reason).toContain('already exists');
  });

  it('reports stale staging directories left by an earlier run', async () => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    const stale = path.join(outputDir, '.archive-legacy-export-1-abc');
    await mkdir(stale);
    const result = await command.execute(options(), runContext(server().uri, [guildId]));
    expect(result.report).toMatchObject({ staleStagingDirs: [stale] });
  });

  const expectStagingKept = async (tampering: ZipTools) => {
    const guildId = nextGuildId();
    await seedRebuild(guildId);
    const result = await createExportCommand(tampering).execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );
    expect(result.exitCode).toBe(1);
    const entries = await readdir(outputDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.archive-legacy-export-/);
    return { report: guildReport(result.report), staging: path.join(outputDir, entries[0] ?? '') };
  };

  it('keeps the staging directory and publishes nothing when verification fails', async () => {
    // Pack an extra, unlisted file so the archive no longer matches its manifest.
    const { report, staging } = await expectStagingKept({
      ...tools,
      create: async (sourceDir, zipPath) => {
        await mkdir(path.join(sourceDir, 'channel-deleted'), { recursive: true });
        await writeFile(path.join(sourceDir, 'channel-deleted/99.json'), '[]');
        await tools.create(sourceDir, zipPath);
      },
    });
    expect(report).toMatchObject({
      status: 'verification-failed',
      stagingDir: staging,
      verification: { ok: false, errors: ['channel-deleted/99.json: not listed in the manifest'] },
    });
  });

  it('rejects an archive whose packed manifest differs from the staged one', async () => {
    const { report } = await expectStagingKept({
      ...tools,
      create: async (sourceDir, zipPath) => {
        await tools.create(sourceDir, zipPath);
        await writeFile(path.join(sourceDir, 'manifest.json'), '{}');
      },
    });
    expect(report).toMatchObject({
      status: 'verification-failed',
      verification: { ok: false, errors: ['manifest.json: differs from the staged manifest'] },
    });
  });

  it('reports an error naming the kept staging directory when packing throws', async () => {
    const { report, staging } = await expectStagingKept({
      ...tools,
      create: () => Promise.reject(new Error('disk full')),
    });
    expect(report.status).toBe('error');
    expect(report.error).toContain('disk full');
    expect(report.error).toContain('nothing published');
    expect(report.error).toContain(staging);
  });
});
