/**
 * Collection catalogue shared by the three `archive-legacy-*` commands.
 *
 * The rebuild moves every legacy message-archive collection aside under
 * one `legacy_<timestamp>_<name>` prefix, exports what the new backup
 * cannot reproduce, then drops the prefixed set. The names here mirror
 * the collections the pre-rebuild archive code reads and writes
 * (`src/persistence/schemas/`, `src/persistence/repositories/archive.repo.ts`,
 * `src/application/archive/`, `src/plugins/message-backup/`); they are copied
 * rather than imported because those modules are being rewritten for the
 * new schema while this tool must keep describing the old layout.
 */
import path from 'node:path';

import type { mongo } from 'mongoose';
import { z } from 'zod';

/** Legacy data collections renamed aside by `archive-legacy-isolate`. */
export const ISOLATED_COLLECTIONS = [
  'messages',
  'archive_revisions',
  'archive_reactions',
  'archive_quarantine',
  'archive_channels',
  // The per-channel fetch checkpoints (`fetch.schema.ts`, `FetchRepository`).
  'fetches',
  'archive_inbox',
] as const;
type IsolatedCollection = (typeof ISOLATED_COLLECTIONS)[number];

/** Control metadata dropped by `archive-legacy-isolate`; nothing in it is exported. */
export const DROPPED_EXACT: ReadonlySet<string> = new Set([
  'archive_journals',
  'archive_jobs',
  'archive_periodic_runs',
  'archive_progress_details',
  'archive_plan_deletions',
  'archive_gc_checkpoints',
  // Gateway continuity proves only that the old archive was captured losslessly;
  // without it the first worker start after the rebuild reconciles fully.
  'archive_gateway_continuity',
  // Start approvals of `/archive backup`; an approval from before the rebuild is void.
  'archive_control_confirmations',
  // The worker's host storage sample; the next sample after the rebuild replaces it.
  'archive_storage_usage',
]);
const DROPPED_PREFIXES = ['archive_repair_', 'archive_control_', 'archive_bulk_'] as const;

/** Kept as-is: `archive_schedule` is forced to disabled, `archive_leases` proves ownership. */
export const SCHEDULE_COLLECTION = 'archive_schedule';
export const LEASES_COLLECTION = 'archive_leases';

/** Collections the new backup writes and the export reads. */
export const NEW_MESSAGES_COLLECTION = 'messages';
export const NEW_CHANNELS_COLLECTION = 'archive_channels';
export const NEW_JOBS_COLLECTION = 'archive_jobs';

export type IsolationAction = 'rename' | 'drop' | 'disable-schedule' | 'keep' | 'keep-unclassified';

const isIsolated = (name: string): name is IsolatedCollection =>
  (ISOLATED_COLLECTIONS as readonly string[]).includes(name);

/** Decide what isolation does with one existing collection, or `null` when it is out of scope. */
export const isolationActionFor = (name: string): IsolationAction | null => {
  if (isIsolated(name)) return 'rename';
  if (DROPPED_EXACT.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix)))
    return 'drop';
  if (name === SCHEDULE_COLLECTION) return 'disable-schedule';
  if (name === LEASES_COLLECTION) return 'keep';
  // Unknown archive collections are reported but never touched.
  if (name.startsWith('archive_')) return 'keep-unclassified';
  return null;
};

/**
 * What the export does with each isolated collection, recorded in the
 * manifest so drop can prove every legacy collection was accounted for:
 * - `compared-against-new-backup`: documents whose message the new backup
 *   lacks are exported; the rest are intentionally discarded (D7).
 * - `exported`: every unprocessed inbox event is exported; completed
 *   events were already applied to the legacy archive.
 * - `dropped-by-policy`: scan state the new backup rebuilds itself.
 */
export type LegacyHandling = 'exported' | 'compared-against-new-backup' | 'dropped-by-policy';

const LEGACY_HANDLING: Readonly<Record<IsolatedCollection, LegacyHandling>> = {
  messages: 'compared-against-new-backup',
  archive_quarantine: 'compared-against-new-backup',
  archive_revisions: 'compared-against-new-backup',
  archive_reactions: 'compared-against-new-backup',
  archive_inbox: 'exported',
  archive_channels: 'dropped-by-policy',
  fetches: 'dropped-by-policy',
};

/** The export handling of a legacy source collection, or `null` when isolation never creates it. */
export const legacyHandlingFor = (source: string): LegacyHandling | null =>
  isIsolated(source) ? LEGACY_HANDLING[source] : null;

/** Millisecond epoch digits, as produced by `Date.now()` at isolation time. */
export const legacyTimestampSchema = z
  .string()
  .regex(/^\d{1,16}$/, 'must be the all-digit timestamp reported by archive-legacy-isolate');

export const legacyCollectionName = (timestamp: string, name: string): string =>
  `legacy_${timestamp}_${name}`;

const LEGACY_NAME = /^legacy_(\d{1,16})_(.+)$/;

/** Parse a `legacy_<timestamp>_<name>` collection name. */
export const parseLegacyCollectionName = (
  name: string,
): { readonly timestamp: string; readonly source: string } | null => {
  const match = LEGACY_NAME.exec(name);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { timestamp: match[1], source: match[2] };
};

export const listCollectionNames = async (db: mongo.Db): Promise<readonly string[]> => {
  const entries = await db.listCollections({}, { nameOnly: true }).toArray();
  return entries
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
};

/** The collections of one legacy set, ascending. */
export const legacySetNames = (names: readonly string[], timestamp: string): readonly string[] =>
  names.filter((name) => parseLegacyCollectionName(name)?.timestamp === timestamp);

/** The distinct legacy timestamps present in a database, ascending. */
export const legacyTimestampsIn = (names: readonly string[]): readonly string[] =>
  [
    ...new Set(
      names
        .map((name) => parseLegacyCollectionName(name)?.timestamp)
        .filter((t) => t !== undefined),
    ),
  ].sort();

export interface CollectionStats {
  readonly documentCount: number;
  /** Uncompressed BSON size in bytes. */
  readonly sizeBytes: number;
  /** On-disk (compressed) size in bytes. */
  readonly storageBytes: number;
}

/**
 * Storage statistics read from `$collStats`, so even a multi-gigabyte
 * collection is not scanned. A sharded collection yields one document per
 * shard, so the figures are summed.
 */
export const collectionStats = async (db: mongo.Db, name: string): Promise<CollectionStats> => {
  const shards = await db
    .collection(name)
    .aggregate<{ storageStats?: { count?: number; size?: number; storageSize?: number } }>([
      { $collStats: { storageStats: {} } },
    ])
    .toArray();
  return shards.reduce<CollectionStats>(
    (sum, shard) => ({
      documentCount: sum.documentCount + (shard.storageStats?.count ?? 0),
      sizeBytes: sum.sizeBytes + (shard.storageStats?.size ?? 0),
      storageBytes: sum.storageBytes + (shard.storageStats?.storageSize ?? 0),
    }),
    { documentCount: 0, sizeBytes: 0, storageBytes: 0 },
  );
};

/** Resolve the mongoose connection's database handle, which is unset until it connects. */
export const requireDb = (db: mongo.Db | undefined, guildId: string): mongo.Db => {
  if (db === undefined) {
    throw new Error(`mongoose connection has no resolved db handle for guild ${guildId}`);
  }
  return db;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
/** Default home of export archives: `tools/db/backups/`, which is gitignored. */
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'tools', 'db', 'backups');

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Absolute output directory; a relative configured path resolves against
 * the working directory. Refuses paths `unzip` would treat as wildcards and
 * any location inside the repository other than the gitignored default,
 * because the archives hold private channel content.
 */
export const resolveOutputDir = (configured: string | null): string => {
  const dir = configured === null ? DEFAULT_OUTPUT_DIR : path.resolve(configured);
  if (/[*?[]/.test(dir)) {
    throw new Error(`output_dir ${dir} must not contain "*", "?" or "["`);
  }
  if (isWithin(REPO_ROOT, dir) && !isWithin(DEFAULT_OUTPUT_DIR, dir)) {
    throw new Error(
      `output_dir ${dir} is inside the repository; use tools/db/backups/ or a path outside it`,
    );
  }
  return dir;
};

export const exportArchiveName = (guildId: string, timestamp: string): string =>
  `archive-legacy-${guildId}-${timestamp}.zip`;
