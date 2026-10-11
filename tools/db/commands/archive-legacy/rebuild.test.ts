/**
 * End-to-end suite for the whole rebuild sequence on one small guild:
 * isolate, a simulated rebuild by msg-archive, export, then drop. Asserts
 * that the legacy set is gone, the verified archive remains, and every
 * collection the rebuild must keep is intact.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createZipTools } from '../../framework/zip-tools';

import { createDropCommand } from './drop';
import { createExportCommand } from './export';
import { createIsolateCommand } from './isolate';
import { verifyExportArchive } from './verify';
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
const tools = createZipTools();
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
  outputDir = await mkdtemp(path.join(tmpdir(), 'archive-legacy-rebuild-'));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe('archive-legacy / rebuild end to end', () => {
  it('isolates, exports what the rebuild lacks, and drops the legacy set', async () => {
    const guildId = nextGuildId();
    const ctx = runContext(server().uri, [guildId]);
    await withGuildDb(server().uri, guildId, async (db) => {
      await db.collection('messages').insertMany([
        { messageId: '1', channelId: '10', channelName: 'general', content: 'still here' },
        { messageId: '2', channelId: '10', channelName: 'general', content: 'deleted later' },
        { messageId: '3', channelId: '11', channelName: 'removed', content: 'channel gone' },
      ]);
      await db.collection('archive_revisions').insertOne({ messageId: '2', snapshot: {} });
      await db.collection('archive_reactions').insertOne({ messageId: '3', userIds: ['7'] });
      await db.collection('archive_inbox').insertOne({ eventId: 'e', state: 'pending' });
      await db.collection('fetches').insertOne({ channelID: '10' });
      await db.collection('archive_jobs').insertOne({ jobId: 'legacy-job' });
      await db.collection<StringIdDocument>('archive_schedule').insertOne({
        _id: 'current',
        enabled: true,
        nextRunAt: 1,
        running: false,
        revision: 0,
        pauseVersion: 0,
      });
      await db.createCollection('archive_leases');
      await db.collection('todos').insertOne({ t: 1 });
    });

    const isolated = await createIsolateCommand(() => NOW).execute({ dry_run: false }, ctx);
    expect(isolated.exitCode).toBe(0);

    // msg-archive rebuilds: message 1 is backed up again, message 2 left only a tombstone.
    await withGuildDb(server().uri, guildId, async (db) => {
      await db.collection('archive_jobs').insertOne({
        jobId: 'rebuild',
        command: 'full-backup',
        status: 'complete',
        finishedAt: NOW + 1000,
        result: { cutoff: NOW + 500 },
      });
      await db.collection('archive_channels').insertMany([
        { channelId: '10', access: 'readable' },
        { channelId: '11', access: 'deleted' },
      ]);
      await db.collection<StringIdDocument>('messages').insertMany([
        { _id: '1', schemaVersion: 3, channelId: '10', author: { id: '9' }, content: 'still here' },
        { _id: '2', schemaVersion: 3, channelId: '10', deletedAt: NOW + 10 },
      ]);
    });

    const exported = await createExportCommand(tools).execute(
      { dry_run: false, legacy_timestamp: TS, output_dir: outputDir },
      ctx,
    );
    expect(exported.exitCode).toBe(0);
    const dropped = await createDropCommand(tools).execute(
      { dry_run: false, legacy_timestamp: TS, output_dir: outputDir },
      ctx,
    );
    expect(dropped.exitCode).toBe(0);

    const names = await collectionNames(server().uri, guildId);
    expect(names.filter((name) => name.startsWith('legacy_'))).toEqual([]);
    expect(names).toEqual([
      'archive_channels',
      'archive_jobs',
      'archive_leases',
      'archive_schedule',
      'messages',
      'todos',
    ]);
    const zipName = `archive-legacy-${guildId}-${TS}.zip`;
    expect(await readdir(outputDir)).toEqual([zipName]);
    const { report, manifest } = await verifyExportArchive(path.join(outputDir, zipName), tools);
    expect(report.ok).toBe(true);
    expect(manifest?.files.map((f) => [f.path, f.records])).toEqual([
      ['channel-deleted/11.json', 2],
      ['inbox/pending.json', 1],
      ['message-missing/10.json', 2],
    ]);
    const state = await withGuildDb(server().uri, guildId, async (db) => ({
      leases: await db.collection('archive_leases').countDocuments(),
      schedule: await db
        .collection<StringIdDocument>('archive_schedule')
        .findOne({ _id: 'current' }),
      todos: await db.collection('todos').countDocuments(),
      messages: await db.collection('messages').countDocuments(),
    }));
    expect(state).toMatchObject({ leases: 0, schedule: { enabled: false }, todos: 1, messages: 2 });
  });
});
