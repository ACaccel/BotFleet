/**
 * The `manifest.json` contract of a legacy-archive export.
 *
 * The manifest is the archive's table of contents: which guild and
 * legacy set it came from, the new backup it was compared against, every
 * legacy collection with its document count and handling, the
 * per-category totals, and every data file with its record counts and
 * sha256. Verification (`verify.ts`) re-derives the file facts from the
 * archive, and `archive-legacy-drop` refuses unless the manifest names
 * the guild and legacy timestamp being dropped and still accounts for
 * every legacy collection with an unchanged document count.
 */
import { z } from 'zod';

export const EXPORT_FORMAT = 'botfleet.archive-legacy-export';
export const EXPORT_FORMAT_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';

/** How an exported record relates to the new backup. */
export const EXPORT_CATEGORIES = [
  // Messages, decided by the channel's access state in the new backup.
  'channel-deleted',
  'channel-inaccessible',
  'message-missing',
  // A legacy document with no usable message or channel ID cannot be matched or placed.
  'unattributed',
  // Live events the legacy writer had not yet applied.
  'inbox-pending',
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

/** Legacy collections whose documents appear in an export. */
export const EXPORTED_SOURCES = [
  'messages',
  'archive_quarantine',
  'archive_revisions',
  'archive_reactions',
  'archive_inbox',
] as const;
export type ExportedSource = (typeof EXPORTED_SOURCES)[number];

const count = z.number().int().nonnegative();
const sourceCountsSchema = z.object({
  messages: count,
  archive_quarantine: count,
  archive_revisions: count,
  archive_reactions: count,
  archive_inbox: count,
});
export type SourceCounts = z.infer<typeof sourceCountsSchema>;

export const emptySourceCounts = (): SourceCounts => ({
  messages: 0,
  archive_quarantine: 0,
  archive_revisions: 0,
  archive_reactions: 0,
  archive_inbox: 0,
});

/** Every archive-relative data path; anything else in an archive is rejected. */
export const DATA_FILE_PATH =
  /^(?:(?:channel-deleted|channel-inaccessible|message-missing)\/\d{1,20}|unattributed|inbox\/pending)\.json$/;

const manifestFileSchema = z.object({
  path: z.string().regex(DATA_FILE_PATH),
  category: z.enum(EXPORT_CATEGORIES),
  channelId: z.string().nullable(),
  /** Channel name as last recorded by the legacy documents; the new backup no longer stores it. */
  channelName: z.string().nullable(),
  records: count,
  counts: sourceCountsSchema,
  bytes: count,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ManifestFile = z.infer<typeof manifestFileSchema>;

const newBackupSchema = z.object({
  jobId: z.string(),
  finishedAt: z.number().nullable(),
  cutoff: z.number().nullable(),
});
export type NewBackupReference = z.infer<typeof newBackupSchema>;

const legacyCollectionSchema = z.object({
  name: z.string(),
  source: z.string(),
  /** Exact `countDocuments` when the export ran; drop requires it to be unchanged. */
  documentCount: count,
  handling: z.enum(['exported', 'compared-against-new-backup', 'dropped-by-policy']),
});
export type LegacyCollectionEntry = z.infer<typeof legacyCollectionSchema>;

export const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  guildId: z.string().regex(/^\d+$/),
  legacyTimestamp: z.string().regex(/^\d+$/),
  generatedAt: z.string(),
  /** The completed full backup the export was compared against; `null` only when forced. */
  newBackup: newBackupSchema.nullable(),
  forced: z.boolean(),
  legacyCollections: z.array(legacyCollectionSchema),
  categories: z.record(z.enum(EXPORT_CATEGORIES), sourceCountsSchema),
  files: z.array(manifestFileSchema),
});
export type ExportManifest = z.infer<typeof manifestSchema>;
