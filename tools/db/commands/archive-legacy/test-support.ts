/**
 * Shared fixtures for the `archive-legacy-*` suites: one in-memory
 * MongoDB per suite file (each test takes fresh guild databases from
 * {@link nextGuildId}), a run context wired to it through the real
 * per-guild connection helper, and builders for hand-made export
 * archives used by the verifier suite.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type mongo } from 'mongoose';

import { createLogger } from '../../../../src/core/logger';
import type { DbRunContext } from '../../framework/command';
import { withGuildConnection } from '../../framework/connection';
import type { ZipTools } from '../../framework/zip-tools';

import {
  EXPORT_CATEGORIES,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORTED_SOURCES,
  MANIFEST_FILE,
  emptySourceCounts,
  type ExportManifest,
  type ManifestFile,
} from './manifest';
import { RecordSpool, type ExportRecord, type RecordPlacement } from './spool';

/** A seeded document with a string `_id`, as the archive's singleton and v3 message documents use. */
export type StringIdDocument = { _id: string } & Record<string, unknown>;

export interface TestMongo {
  /** Base URI in the normalized host-with-trailing-slash form `loadConfig` produces. */
  readonly uri: string;
  stop(): Promise<void>;
}

export const startTestMongo = async (): Promise<TestMongo> => {
  const server = await MongoMemoryServer.create();
  return {
    uri: `${server.getUri().split('?', 1)[0]?.replace(/\/+$/, '') ?? ''}/`,
    stop: async () => {
      await server.stop({ doCleanup: true, force: true });
    },
  };
};

let guildCounter = 100_000;
/** A guild ID no other test in the process has used, so each test gets empty databases. */
export const nextGuildId = (): string => String((guildCounter += 1));

export const runContext = (uri: string, guilds: readonly string[]): DbRunContext => ({
  shared: { mongoUri: uri, guilds, outputPath: null },
  logger: createLogger({ level: 'silent', pretty: false }),
  withGuildConnection: (guildId, fn) => withGuildConnection(uri, guildId, fn),
});

/** Run `fn` against one guild database through a short-lived connection. */
export const withGuildDb = async <R>(
  uri: string,
  guildId: string,
  fn: (db: mongo.Db) => Promise<R>,
): Promise<R> => {
  const connection = await mongoose.createConnection(`${uri}${guildId}`).asPromise();
  try {
    if (connection.db === undefined) throw new Error('test connection has no db handle');
    return await fn(connection.db);
  } finally {
    await connection.close();
  }
};

export const collectionNames = (uri: string, guildId: string): Promise<string[]> =>
  withGuildDb(uri, guildId, async (db) =>
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(),
  );

type Entry = { placement: RecordPlacement; record: ExportRecord };

export interface BuiltArchive {
  readonly manifest: ExportManifest;
  /** The staging directory; edit it and call {@link repack} to produce a tampered archive. */
  readonly stage: string;
}

const categoryTotals = (files: readonly ManifestFile[]): ExportManifest['categories'] => {
  const categories: ExportManifest['categories'] = {};
  for (const category of EXPORT_CATEGORIES) {
    const sum = emptySourceCounts();
    for (const file of files.filter((f) => f.category === category)) {
      for (const source of EXPORTED_SOURCES) sum[source] += file.counts[source];
    }
    categories[category] = sum;
  }
  return categories;
};

/** Write `manifest` into `stage` and pack the stage into a fresh `zipPath`. */
export const repack = async (
  tools: ZipTools,
  stage: string,
  zipPath: string,
  manifest: unknown,
): Promise<void> => {
  await writeFile(path.join(stage, MANIFEST_FILE), JSON.stringify(manifest));
  await rm(zipPath, { force: true });
  await tools.create(stage, zipPath);
};

/** Stage and pack an export archive the way the export command does. */
export const buildArchive = async (
  tools: ZipTools,
  workDir: string,
  zipPath: string,
  spec: { guildId: string; legacyTimestamp: string; entries: readonly Entry[] },
): Promise<BuiltArchive> => {
  const stage = path.join(workDir, `stage-${path.basename(zipPath)}`);
  await mkdir(stage, { recursive: true });
  const spool = new RecordSpool(stage);
  await spool.append(spec.entries);
  const files = await spool.finish();
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    guildId: spec.guildId,
    legacyTimestamp: spec.legacyTimestamp,
    generatedAt: new Date(0).toISOString(),
    newBackup: { jobId: 'job-1', finishedAt: 1, cutoff: 1 },
    forced: false,
    legacyCollections: [
      {
        name: `legacy_${spec.legacyTimestamp}_messages`,
        source: 'messages',
        documentCount: spec.entries.length,
        handling: 'compared-against-new-backup',
      },
    ],
    categories: categoryTotals(files),
    files,
  };
  await repack(tools, stage, zipPath, manifest);
  return { manifest, stage };
};

export const sampleEntry = (messageId: string, channelId: string): Entry => ({
  placement: { category: 'message-missing', channelId, channelName: `name-${channelId}` },
  record: { collection: 'messages', messageId, document: { messageId, channelId, content: 'hi' } },
});
