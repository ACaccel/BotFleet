/**
 * `db archive-legacy-export` — export the legacy records the rebuilt
 * archive cannot reproduce, as one verified zip per guild.
 *
 * Scope (see `scan.ts`): legacy `messages` and `archive_quarantine`
 * documents whose message the new `messages` does not hold with content,
 * with their legacy revisions and reaction user lists, grouped into one
 * canonical-EJSON file per channel under its category directory; every
 * unprocessed legacy inbox event; and a `manifest.json` that also
 * records every `legacy_<timestamp>_*` collection with its exact document
 * count and handling, so drop can prove nothing was left unaccounted for.
 * The files are staged in a private directory inside the output
 * directory, packed with the system `zip -r`, and verified from the
 * archive alone (`verify.ts`). Only a verified archive is published as
 * `archive-legacy-<guild>-<timestamp>.zip` (mode 0600), after which the
 * staging directory is removed; a failed run keeps it for diagnosis.
 *
 * Preconditions: the `zip` / `unzip` binaries exist and the output
 * directory is acceptable (both checked before any connection), the
 * legacy set exists and holds only collections isolation creates, the
 * target archive does not exist, and the guild has a full backup that
 * completed after the isolation, unless `force` is set.
 *
 * Safety: `dry_run` defaults to `true` and only counts what would be
 * exported per category, writing nothing.
 */
import { constants } from 'node:fs';
import { access, chmod, link, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Connection, mongo } from 'mongoose';
import { z } from 'zod';

import { defineCommand, type DbCommandResult } from '../../framework/command';
import { runPerGuild, type GuildOutcome } from '../../framework/guild-runner';
import { createZipTools, type ZipTools } from '../../framework/zip-tools';

import {
  exportArchiveName,
  legacyCollectionName,
  legacyHandlingFor,
  legacySetNames,
  legacyTimestampSchema,
  legacyTimestampsIn,
  listCollectionNames,
  parseLegacyCollectionName,
  requireDb,
  resolveOutputDir,
} from './collections';
import {
  emptySourceCounts,
  EXPORT_CATEGORIES,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORTED_SOURCES,
  MANIFEST_FILE,
  type ExportCategory,
  type ExportManifest,
  type LegacyCollectionEntry,
  type ManifestFile,
  type NewBackupReference,
  type SourceCounts,
} from './manifest';
import { findCompletedFullBackup, loadChannelAccess } from './new-backup';
import { scanLegacySet, type LegacySources, type ScanSummary } from './scan';
import { RecordSpool, sha256File } from './spool';
import { verifyExportArchive, type VerificationReport } from './verify';

export const exportOptionsSchema = z.object({
  dry_run: z.boolean().default(true),
  legacy_timestamp: legacyTimestampSchema,
  /** Export even without a completed full backup; every message may then be misclassified as missing. */
  force: z.boolean().default(false),
  /** Archive directory; `null` means `tools/db/backups/`. */
  output_dir: z.string().min(1).nullable().default(null),
  batch_size: z.number().int().min(1).max(10_000).default(1000),
});

type ExportOptions = z.infer<typeof exportOptionsSchema>;

interface ExportSummary {
  readonly newBackup: NewBackupReference | null;
  readonly forced: boolean;
  readonly legacyCollections: readonly LegacyCollectionEntry[];
  readonly scan: ScanSummary;
  readonly categories: Partial<Record<ExportCategory, SourceCounts>>;
  readonly files: readonly Pick<ManifestFile, 'path' | 'category' | 'channelName' | 'records'>[];
}

type ExportSuccess =
  | ({ readonly status: 'would-export' } & ExportSummary)
  | ({
      readonly status: 'exported';
      readonly zipPath: string;
      readonly verification: VerificationReport;
      readonly warnings: readonly string[];
    } & ExportSummary)
  | ({
      readonly status: 'verification-failed';
      readonly stagingDir: string;
      readonly verification: VerificationReport;
    } & ExportSummary)
  | { readonly status: 'refused'; readonly reason: string };

type FlatOutcome = { readonly guildId: string } & (
  | ExportSuccess
  | { readonly status: 'error'; readonly error: string }
);

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const STAGING_PREFIX = '.archive-legacy-export-';

const exists = async (file: string): Promise<boolean> =>
  access(file, constants.F_OK).then(
    () => true,
    () => false,
  );

/** Staging directories a crashed or failed earlier run left behind; they hold private content. */
const staleStagingDirs = async (outputDir: string): Promise<string[]> => {
  const entries = await readdir(outputDir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.startsWith(STAGING_PREFIX))
    .map((name) => path.join(outputDir, name));
};

const totalsByCategory = (
  files: readonly ManifestFile[],
): Partial<Record<ExportCategory, SourceCounts>> => {
  const totals: Partial<Record<ExportCategory, SourceCounts>> = {};
  for (const category of EXPORT_CATEGORIES) {
    const sum = emptySourceCounts();
    for (const file of files.filter((f) => f.category === category)) {
      for (const source of EXPORTED_SOURCES) sum[source] += file.counts[source];
    }
    totals[category] = sum;
  }
  return totals;
};

interface GuildPlan {
  readonly guildId: string;
  readonly timestamp: string;
  readonly sources: LegacySources;
  readonly legacyCollections: readonly LegacyCollectionEntry[];
  readonly newBackup: NewBackupReference | null;
  readonly zipPath: string;
}

const summarize = (
  plan: GuildPlan,
  scan: ScanSummary,
  files: readonly ManifestFile[],
): ExportSummary => ({
  newBackup: plan.newBackup,
  forced: plan.newBackup === null,
  legacyCollections: plan.legacyCollections,
  scan,
  categories: totalsByCategory(files),
  files: files.map(({ path: file, category, channelName, records }) => ({
    path: file,
    category,
    channelName,
    records,
  })),
});

/** Inventory the legacy set with exact counts; a string is a refusal reason. */
const inventory = async (
  db: mongo.Db,
  names: readonly string[],
  timestamp: string,
): Promise<LegacyCollectionEntry[] | string> => {
  const set = legacySetNames(names, timestamp);
  if (!set.includes(legacyCollectionName(timestamp, 'messages'))) {
    const found = legacyTimestampsIn(names);
    return `legacy set ${timestamp} has no messages collection (legacy sets present: ${found.length === 0 ? 'none' : found.join(', ')})`;
  }
  const entries: LegacyCollectionEntry[] = [];
  for (const name of set) {
    const source = parseLegacyCollectionName(name)?.source ?? name;
    const handling = legacyHandlingFor(source);
    if (handling === null) {
      return `${name} is not a collection archive-legacy-isolate creates; inspect it before exporting`;
    }
    entries.push({
      name,
      source,
      documentCount: await db.collection(name).countDocuments({}),
      handling,
    });
  }
  return entries;
};

/** Resolve the legacy set and check every precondition; a string is a refusal reason. */
const planGuild = async (
  connection: Connection,
  guildId: string,
  options: ExportOptions,
  outputDir: string,
): Promise<GuildPlan | string> => {
  const db = requireDb(connection.db, guildId);
  const names = await listCollectionNames(db);
  const timestamp = options.legacy_timestamp;
  const legacyCollections = await inventory(db, names, timestamp);
  if (typeof legacyCollections === 'string') return legacyCollections;
  const present = new Set(legacyCollections.map((entry) => entry.name));
  const sourceName = (source: string): string | null => {
    const name = legacyCollectionName(timestamp, source);
    return present.has(name) ? name : null;
  };
  const sources: LegacySources = {
    messages: sourceName('messages'),
    archive_quarantine: sourceName('archive_quarantine'),
    archive_revisions: sourceName('archive_revisions'),
    archive_reactions: sourceName('archive_reactions'),
    archive_inbox: sourceName('archive_inbox'),
  };
  const newBackup = await findCompletedFullBackup(db, Number(timestamp));
  if (newBackup === null && !options.force) {
    return `no full-backup job completed after the isolation (${timestamp}); finish /archive backup first, or set force: true`;
  }
  const zipPath = path.join(outputDir, exportArchiveName(guildId, timestamp));
  if (!options.dry_run && (await exists(zipPath))) {
    return `${zipPath} already exists; move it away before exporting again`;
  }
  return { guildId, timestamp, sources, legacyCollections, newBackup, zipPath };
};

const buildManifest = (
  plan: GuildPlan,
  files: readonly ManifestFile[],
  generatedAt: Date,
): ExportManifest => ({
  format: EXPORT_FORMAT,
  formatVersion: EXPORT_FORMAT_VERSION,
  guildId: plan.guildId,
  legacyTimestamp: plan.timestamp,
  generatedAt: generatedAt.toISOString(),
  newBackup: plan.newBackup,
  forced: plan.newBackup === null,
  legacyCollections: [...plan.legacyCollections],
  categories: totalsByCategory(files),
  files: [...files],
});

/** Stage, pack, and verify; the staging directory survives unless verification passes. */
const writeArchive = async (
  db: mongo.Db,
  plan: GuildPlan,
  options: ExportOptions,
  outputDir: string,
  tools: ZipTools,
  now: () => Date,
): Promise<ExportSuccess> => {
  await mkdir(outputDir, { recursive: true, mode: DIR_MODE });
  // mkdtemp creates the directory with mode 0700; the staged files hold private channel content.
  const work = await mkdtemp(path.join(outputDir, `${STAGING_PREFIX}${plan.guildId}-`));
  let published = false;
  try {
    const stage = path.join(work, 'stage');
    await mkdir(stage, { mode: DIR_MODE });
    const spool = new RecordSpool(stage);
    const access = await loadChannelAccess(db);
    const scan = await scanLegacySet(db, plan.sources, access, spool, options.batch_size);
    const files = await spool.finish();
    const manifestPath = path.join(stage, MANIFEST_FILE);
    const manifest = buildManifest(plan, files, now());
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });
    const zipTemp = path.join(work, 'export.zip');
    await tools.create(stage, zipTemp);
    await chmod(zipTemp, FILE_MODE);
    const summary = summarize(plan, scan, files);
    const { report } = await verifyExportArchive(zipTemp, tools);
    const manifestMatches = report.manifestSha256 === (await sha256File(manifestPath));
    const verification: VerificationReport = manifestMatches
      ? report
      : {
          ...report,
          ok: false,
          errors: [...report.errors, `${MANIFEST_FILE}: differs from the staged manifest`],
        };
    if (!verification.ok) {
      return { status: 'verification-failed', stagingDir: work, verification, ...summary };
    }
    // link() refuses an existing target, so a concurrent run can never overwrite an archive.
    await link(zipTemp, plan.zipPath);
    published = true;
    const warnings: string[] = [];
    await rm(work, { recursive: true, force: true }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(
        `staging directory ${work} could not be removed (${reason}); delete it by hand`,
      );
    });
    return {
      status: 'exported',
      zipPath: plan.zipPath,
      // The published file is a hard link to the verified one, so the result carries over.
      verification: { ...verification, zipPath: plan.zipPath },
      warnings,
      ...summary,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const where = published ? `archive published at ${plan.zipPath}` : 'nothing published';
    throw new Error(`${reason} (${where}; staging directory kept at ${work})`, { cause: error });
  }
};

const processGuild = async (
  connection: Connection,
  guildId: string,
  options: ExportOptions,
  outputDir: string,
  tools: ZipTools,
  now: () => Date,
): Promise<ExportSuccess> => {
  const plan = await planGuild(connection, guildId, options, outputDir);
  if (typeof plan === 'string') return { status: 'refused', reason: plan };
  const db = requireDb(connection.db, guildId);
  if (!options.dry_run) return writeArchive(db, plan, options, outputDir, tools, now);
  const spool = new RecordSpool(null);
  const access = await loadChannelAccess(db);
  const scan = await scanLegacySet(db, plan.sources, access, spool, options.batch_size);
  return { status: 'would-export', ...summarize(plan, scan, await spool.finish()) };
};

const toFlatOutcome = (o: GuildOutcome<ExportSuccess>): FlatOutcome =>
  o.ok && o.result !== null
    ? { guildId: o.guildId, ...o.result }
    : { guildId: o.guildId, status: 'error', error: o.error ?? 'unknown error' };

export const createExportCommand = (
  tools: ZipTools = createZipTools(),
  now: () => Date = () => new Date(),
) =>
  defineCommand<ExportOptions>({
    name: 'archive-legacy-export',
    description: 'Export legacy messages missing from the rebuilt archive into a verified zip.',
    optionsSchema: exportOptionsSchema,
    run: async ({ shared, options, logger, withGuildConnection }): Promise<DbCommandResult> => {
      const outputDir = resolveOutputDir(options.output_dir);
      await tools.assertAvailable();
      const stale = await staleStagingDirs(outputDir);
      if (stale.length > 0) {
        logger.warn(
          { staleStagingDirs: stale },
          'db archive-legacy-export: stale staging directories found',
        );
      }
      logger.info(
        {
          guildCount: shared.guilds.length,
          dryRun: options.dry_run,
          legacyTimestamp: options.legacy_timestamp,
          outputDir,
        },
        options.dry_run
          ? 'db archive-legacy-export: DRY RUN — counting only, no files are written.'
          : 'db archive-legacy-export: exporting legacy records missing from the new backup.',
      );
      const outcomes = await runPerGuild<ExportSuccess>(
        shared.guilds,
        (guildId) =>
          withGuildConnection(guildId, (connection) =>
            processGuild(connection, guildId, options, outputDir, tools, now),
          ),
        logger,
        'db archive-legacy-export',
      );
      const guilds = outcomes.map(toFlatOutcome);
      const failed = guilds.filter(
        (g) => g.status !== 'exported' && g.status !== 'would-export',
      ).length;
      return {
        report: {
          dryRun: options.dry_run,
          legacyTimestamp: options.legacy_timestamp,
          outputDir,
          staleStagingDirs: stale,
          guilds,
        },
        summaryLine:
          failed === 0
            ? 'PASS'
            : `FAIL (${String(failed)} guild(s) refused, unverified, or errored)`,
        exitCode: failed === 0 ? 0 : 1,
      };
    },
  });

export const exportCommand = createExportCommand();
