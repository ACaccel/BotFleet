/**
 * Suite for `archive-legacy-drop` against an in-memory MongoDB and the
 * real `zip` / `unzip` binaries. Archives come from the real exporter:
 * the dry-run listing, the real drop, and every refusal (missing or
 * tampered archive, manifest naming another guild or legacy timestamp,
 * legacy collections added or changed after the export).
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createZipTools } from '../../framework/zip-tools';

import { exportArchiveName } from './collections';
import { createDropCommand, dropOptionsSchema } from './drop';
import { createExportCommand } from './export';
import {
  collectionNames,
  nextGuildId,
  runContext,
  startTestMongo,
  withGuildDb,
  type TestMongo,
} from './test-support';

const TS = '1790000000000';
const OTHER_TS = '1780000000000';
const tools = createZipTools();
const command = createDropCommand(tools);
const exporter = createExportCommand(tools);
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
  outputDir = await mkdtemp(path.join(tmpdir(), 'archive-legacy-drop-'));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

/** Two legacy sets, a completed rebuild, and one channel deleted since the legacy capture. */
const seedGuild = (guildId: string): Promise<void> =>
  withGuildDb(server().uri, guildId, async (db) => {
    for (const ts of [TS, OTHER_TS]) {
      await db.collection(`legacy_${ts}_messages`).insertMany([
        { messageId: '1', channelId: '12' },
        { messageId: '2', channelId: '12' },
      ]);
      await db.collection(`legacy_${ts}_fetches`).insertOne({ channelID: '12' });
    }
    await db
      .collection('archive_jobs')
      .insertOne({ command: 'full-backup', status: 'complete', finishedAt: Number(TS) + 1 });
    await db.collection('archive_channels').insertOne({ channelId: '12', access: 'deleted' });
    await db.collection('messages').insertOne({ schemaVersion: 3, content: 'new' });
  });

const archiveFor = (guildId: string, ts = TS): string =>
  path.join(outputDir, exportArchiveName(guildId, ts));

const exportGuild = async (guildId: string, ts = TS): Promise<void> => {
  const result = await exporter.execute(
    { dry_run: false, legacy_timestamp: ts, output_dir: outputDir },
    runContext(server().uri, [guildId]),
  );
  expect(result.exitCode).toBe(0);
};

const options = (overrides: Record<string, unknown> = {}) => ({
  legacy_timestamp: TS,
  output_dir: outputDir,
  ...overrides,
});

describe('archive-legacy-drop / options', () => {
  it('defaults to a dry run and requires the legacy timestamp', () => {
    expect(dropOptionsSchema.parse({ legacy_timestamp: TS })).toEqual({
      dry_run: true,
      legacy_timestamp: TS,
      output_dir: null,
    });
    expect(dropOptionsSchema.safeParse({}).success).toBe(false);
  });

  it('fails fast before connecting when unzip is missing', async () => {
    const missing = createDropCommand(
      createZipTools({ zip: 'zip', unzip: 'botfleet-no-such-unzip' }),
    );
    await expect(
      missing.execute(options(), runContext(server().uri, [nextGuildId()])),
    ).rejects.toThrow(/not found on PATH/);
  });
});

describe('archive-legacy-drop / runs', () => {
  it('lists only the matching legacy set in a dry run and drops nothing', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);
    const before = await collectionNames(server().uri, guildId);

    const result = await command.execute(options(), runContext(server().uri, [guildId]));

    expect(result.exitCode).toBe(0);
    expect(result.summaryLine).toBe('PASS');
    expect(result.report).toMatchObject({
      guilds: [
        {
          status: 'would-drop',
          verification: { ok: true },
          collections: [
            { name: `legacy_${TS}_fetches`, documentCount: 1 },
            { name: `legacy_${TS}_messages`, documentCount: 2 },
          ],
        },
      ],
    });
    expect(await collectionNames(server().uri, guildId)).toEqual(before);
  });

  it('drops the verified legacy set and reports absent on a re-run', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);

    const dropped = await command.execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );
    expect(dropped.exitCode).toBe(0);
    expect(dropped.report).toMatchObject({ guilds: [{ status: 'dropped' }] });
    expect(await collectionNames(server().uri, guildId)).toEqual([
      'archive_channels',
      'archive_jobs',
      `legacy_${OTHER_TS}_fetches`,
      `legacy_${OTHER_TS}_messages`,
      'messages',
    ]);

    const again = await command.execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );
    expect(again.exitCode).toBe(0);
    expect(again.report).toMatchObject({ guilds: [{ status: 'absent', collections: [] }] });
  });
});

describe('archive-legacy-drop / refusals', () => {
  const expectRefusal = async (guildId: string, reason: RegExp): Promise<void> => {
    const before = await collectionNames(server().uri, guildId);
    const result = await command.execute(
      options({ dry_run: false }),
      runContext(server().uri, [guildId]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summaryLine).toBe('FAIL (1 guild(s) refused or errored)');
    expect(result.report).toMatchObject({
      guilds: [{ status: 'refused', reason: expect.stringMatching(reason) }],
    });
    expect(await collectionNames(server().uri, guildId)).toEqual(before);
  };

  /** Replace or add entries in an exported archive (`zip` updates an existing archive in place). */
  const patchArchive = async (zipPath: string, files: Record<string, string>): Promise<void> => {
    const patch = await mkdtemp(path.join(tmpdir(), 'archive-legacy-patch-'));
    try {
      for (const [name, body] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(patch, name)), { recursive: true });
        await writeFile(path.join(patch, name), body);
      }
      await tools.create(patch, zipPath);
    } finally {
      await rm(patch, { recursive: true, force: true });
    }
  };

  it('refuses when the export archive is missing', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await expectRefusal(guildId, /not found/);
  });

  it('refuses when the export archive is corrupt', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await writeFile(archiveFor(guildId), 'corrupt');
    await expectRefusal(guildId, /failed verification/);
  });

  it('refuses when a data file no longer matches the manifest', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);
    await patchArchive(archiveFor(guildId), { 'channel-deleted/12.json': '[\n]\n' });
    await expectRefusal(guildId, /failed verification/);
  });

  it('refuses when the archive holds a file the manifest does not list', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);
    await patchArchive(archiveFor(guildId), { 'channel-deleted/99.json': '[]' });
    await expectRefusal(guildId, /failed verification/);
  });

  it('refuses when the manifest names another guild', async () => {
    const guildId = nextGuildId();
    const otherGuild = nextGuildId();
    await seedGuild(guildId);
    await seedGuild(otherGuild);
    await exportGuild(otherGuild);
    await copyFile(archiveFor(otherGuild), archiveFor(guildId));
    await expectRefusal(guildId, new RegExp(`for guild ${otherGuild}`));
  });

  it('refuses when the manifest names another legacy timestamp', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId, OTHER_TS);
    await copyFile(archiveFor(guildId, OTHER_TS), archiveFor(guildId));
    await expectRefusal(guildId, new RegExp(`legacy ${OTHER_TS}, not`));
  });

  it('refuses when a legacy collection gained documents after the export', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection(`legacy_${TS}_messages`).insertOne({ messageId: '3', channelId: '12' }),
    );
    await expectRefusal(guildId, /holds 3 documents but the export recorded 2/);
  });

  it('refuses when a legacy collection appeared after the export', async () => {
    const guildId = nextGuildId();
    await seedGuild(guildId);
    await exportGuild(guildId);
    await withGuildDb(server().uri, guildId, (db) =>
      db.collection(`legacy_${TS}_archive_inbox`).insertOne({ state: 'pending' }),
    );
    await expectRefusal(guildId, /archive_inbox is not listed in the export manifest/);
  });
});
