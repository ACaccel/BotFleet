/**
 * `db archive-legacy-drop` — permanently drop an isolated legacy set
 * once its export is proven good.
 *
 * Per guild it locates `archive-legacy-<guild>-<timestamp>.zip` in the
 * configured output directory, re-verifies it from the archive alone
 * (`verify.ts`), and requires its manifest to name this guild and this
 * legacy timestamp and to list every remaining `legacy_<timestamp>_*`
 * collection with an unchanged exact document count, so nothing written
 * or created after the export can be lost. Only then does it drop the
 * set. Any failed check refuses the guild and drops nothing.
 *
 * Safety: `dry_run` defaults to `true` and lists the collections and
 * document counts that would be dropped (verification still runs, so a
 * dry run also proves the archive). The `zip` / `unzip` binaries are
 * checked before any connection.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { Connection } from 'mongoose';
import { z } from 'zod';

import { defineCommand, type DbCommandResult } from '../../framework/command';
import { runPerGuild, type GuildOutcome } from '../../framework/guild-runner';
import { createZipTools, type ZipTools } from '../../framework/zip-tools';

import {
  exportArchiveName,
  legacySetNames,
  legacyTimestampSchema,
  listCollectionNames,
  requireDb,
  resolveOutputDir,
} from './collections';
import { verifyExportArchive, type VerificationReport } from './verify';

export const dropOptionsSchema = z.object({
  dry_run: z.boolean().default(true),
  legacy_timestamp: legacyTimestampSchema,
  /** Directory holding the export archives; `null` means `tools/db/backups/`. */
  output_dir: z.string().min(1).nullable().default(null),
});

type DropOptions = z.infer<typeof dropOptionsSchema>;

interface DropTarget {
  readonly name: string;
  readonly documentCount: number;
}

type DropSuccess =
  | {
      readonly status: 'would-drop' | 'dropped' | 'absent';
      readonly zipPath: string;
      readonly verification: VerificationReport;
      readonly collections: readonly DropTarget[];
    }
  | {
      readonly status: 'refused';
      readonly reason: string;
      readonly verification?: VerificationReport;
    };

type FlatOutcome = { readonly guildId: string } & (
  | DropSuccess
  | { readonly status: 'error'; readonly error: string }
);

const processGuild = async (
  connection: Connection,
  guildId: string,
  options: DropOptions,
  outputDir: string,
  tools: ZipTools,
): Promise<DropSuccess> => {
  const timestamp = options.legacy_timestamp;
  const zipPath = path.join(outputDir, exportArchiveName(guildId, timestamp));
  const present = await access(zipPath, constants.R_OK).then(
    () => true,
    () => false,
  );
  if (!present) return { status: 'refused', reason: `export archive ${zipPath} not found` };
  const { report: verification, manifest } = await verifyExportArchive(zipPath, tools);
  if (!verification.ok || manifest === null) {
    return { status: 'refused', reason: 'export archive failed verification', verification };
  }
  if (manifest.guildId !== guildId || manifest.legacyTimestamp !== timestamp) {
    return {
      status: 'refused',
      reason: `export manifest is for guild ${manifest.guildId} / legacy ${manifest.legacyTimestamp}, not guild ${guildId} / legacy ${timestamp}`,
      verification,
    };
  }

  const db = requireDb(connection.db, guildId);
  const names = legacySetNames(await listCollectionNames(db), timestamp);
  const recorded = new Map(manifest.legacyCollections.map((c) => [c.name, c.documentCount]));
  const collections: DropTarget[] = [];
  for (const name of names) {
    const documentCount = await db.collection(name).countDocuments({});
    const exported = recorded.get(name);
    if (exported === undefined) {
      return {
        status: 'refused',
        reason: `${name} is not listed in the export manifest`,
        verification,
      };
    }
    if (exported !== documentCount) {
      return {
        status: 'refused',
        reason: `${name} holds ${String(documentCount)} documents but the export recorded ${String(exported)}`,
        verification,
      };
    }
    collections.push({ name, documentCount });
  }
  if (collections.length === 0) return { status: 'absent', zipPath, verification, collections };
  if (options.dry_run) return { status: 'would-drop', zipPath, verification, collections };
  for (const { name } of collections) await db.dropCollection(name);
  return { status: 'dropped', zipPath, verification, collections };
};

const toFlatOutcome = (o: GuildOutcome<DropSuccess>): FlatOutcome =>
  o.ok && o.result !== null
    ? { guildId: o.guildId, ...o.result }
    : { guildId: o.guildId, status: 'error', error: o.error ?? 'unknown error' };

export const createDropCommand = (tools: ZipTools = createZipTools()) =>
  defineCommand<DropOptions>({
    name: 'archive-legacy-drop',
    description: 'Drop an isolated legacy archive set once its export zip passes checks.',
    optionsSchema: dropOptionsSchema,
    run: async ({ shared, options, logger, withGuildConnection }): Promise<DbCommandResult> => {
      const outputDir = resolveOutputDir(options.output_dir);
      await tools.assertAvailable();
      logger.info(
        {
          guildCount: shared.guilds.length,
          dryRun: options.dry_run,
          legacyTimestamp: options.legacy_timestamp,
          outputDir,
        },
        options.dry_run
          ? 'db archive-legacy-drop: DRY RUN — verifying and listing only, nothing is dropped.'
          : 'db archive-legacy-drop: dropping verified legacy sets in every configured guild.',
      );
      const outcomes = await runPerGuild<DropSuccess>(
        shared.guilds,
        (guildId) =>
          withGuildConnection(guildId, (connection) =>
            processGuild(connection, guildId, options, outputDir, tools),
          ),
        logger,
        'db archive-legacy-drop',
      );
      const guilds = outcomes.map(toFlatOutcome);
      const failed = guilds.filter((g) => g.status === 'refused' || g.status === 'error').length;
      return {
        report: {
          dryRun: options.dry_run,
          legacyTimestamp: options.legacy_timestamp,
          outputDir,
          guilds,
        },
        summaryLine: failed === 0 ? 'PASS' : `FAIL (${String(failed)} guild(s) refused or errored)`,
        exitCode: failed === 0 ? 0 : 1,
      };
    },
  });

export const dropCommand = createDropCommand();
