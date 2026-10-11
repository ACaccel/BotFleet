/**
 * Minimal read-only view of the rebuilt archive, as the export needs it.
 *
 * The export compares legacy documents with the new backup: whether a
 * completed full backup exists, which message IDs it holds with content,
 * and each channel's access state. These projections are declared
 * locally rather than imported from `src/persistence` so the tool depends
 * only on the few stable fields it reads: `messages._id` (the Discord
 * message ID in schema v3) and its content fields,
 * `archive_channels.{channelId, access}`, and the `full-backup` job record
 * in `archive_jobs`.
 */
import type { mongo } from 'mongoose';

import {
  NEW_CHANNELS_COLLECTION,
  NEW_JOBS_COLLECTION,
  NEW_MESSAGES_COLLECTION,
} from './collections';
import type { ExportCategory, NewBackupReference } from './manifest';

/** The job command and terminal status of a finished full backup; known gaps still finish `complete`. */
const FULL_BACKUP_COMMAND = 'full-backup';
const COMPLETED_STATUS = 'complete';

export type ChannelAccess = 'readable' | 'denied' | 'unknown' | 'deleted';

interface JobProjection {
  _id: unknown;
  jobId?: unknown;
  finishedAt?: unknown;
  options?: { cutoff?: unknown };
  result?: { cutoff?: unknown };
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The most recently finished, completed full-backup job that finished
 * after `isolatedAt`, or `null` when there is none. A job that finished
 * before the isolation never ran against the rebuilt archive.
 */
export const findCompletedFullBackup = async (
  db: mongo.Db,
  isolatedAt: number,
): Promise<NewBackupReference | null> => {
  const job = await db
    .collection<JobProjection>(NEW_JOBS_COLLECTION)
    .find(
      { command: FULL_BACKUP_COMMAND, status: COMPLETED_STATUS, finishedAt: { $gt: isolatedAt } },
      { projection: { jobId: 1, finishedAt: 1, 'options.cutoff': 1, 'result.cutoff': 1 } },
    )
    .sort({ finishedAt: -1 })
    .limit(1)
    .next();
  if (job === null) return null;
  return {
    jobId: typeof job.jobId === 'string' ? job.jobId : String(job._id),
    finishedAt: numberOrNull(job.finishedAt),
    cutoff: numberOrNull(job.result?.cutoff) ?? numberOrNull(job.options?.cutoff),
  };
};

/** Every channel's access state in the new backup; one entry per channel, so it fits in memory. */
export const loadChannelAccess = async (
  db: mongo.Db,
): Promise<ReadonlyMap<string, ChannelAccess>> => {
  const access = new Map<string, ChannelAccess>();
  const cursor = db
    .collection<{ channelId?: unknown; access?: unknown }>(NEW_CHANNELS_COLLECTION)
    .find({}, { projection: { _id: 0, channelId: 1, access: 1 } });
  for await (const channel of cursor) {
    if (typeof channel.channelId !== 'string') continue;
    const state = channel.access;
    access.set(
      channel.channelId,
      state === 'readable' || state === 'denied' || state === 'deleted' ? state : 'unknown',
    );
  }
  return access;
};

/**
 * Classify a missing message by its channel's new access state. Only a
 * channel the new backup could read proves the message itself is gone;
 * `unknown` and an unrecorded channel are treated as inaccessible.
 */
export const categoryForChannel = (access: ChannelAccess | undefined): ExportCategory => {
  switch (access) {
    case 'deleted':
      return 'channel-deleted';
    case 'readable':
      return 'message-missing';
    case 'denied':
    case 'unknown':
    case undefined:
      return 'channel-inaccessible';
    default: {
      const unreachable: never = access;
      throw new Error(`Unknown channel access state: ${String(unreachable)}`);
    }
  }
};

/**
 * Fields of which at least one exists on every v3 message the backup
 * actually observed: a full message carries `author` and its content, a
 * policy-limited interaction record `author` and `interactionMetadata`.
 * A document with none of them is a bare tombstone (`_id`,
 * `schemaVersion`, `channelId`, `createdTimestamp`, `observedAt`,
 * `deletedAt` only), written for a deletion of a message the backup
 * never observed; it does not reproduce the legacy content, so its legacy
 * document is still exported. `new-backup.test.ts` checks this against
 * documents written by the archive repository itself.
 */
const CONTENT_FIELDS = [
  'author',
  'content',
  'attachments',
  'embeds',
  'stickers',
  'components',
  'poll',
  'messageSnapshots',
  'interactionMetadata',
] as const;

/** The subset of `ids` the new `messages` collection holds with content; tombstones do not count. */
export const presentMessageIds = async (
  db: mongo.Db,
  ids: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (ids.length === 0) return new Set();
  const found = await db
    .collection<{ _id: string }>(NEW_MESSAGES_COLLECTION)
    .find(
      {
        _id: { $in: [...ids] },
        $or: CONTENT_FIELDS.map((field) => ({ [field]: { $exists: true } })),
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  return new Set(found.map((doc) => doc._id));
};
