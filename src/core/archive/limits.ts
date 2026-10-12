import { z } from 'zod';

/**
 * Shared admission and notification bounds; benchmark trials do not change operator defaults.
 *
 * Concurrency sets how many sources one guild reads at once. It does not bound
 * memory or Discord load: the owner's `pipelineBytes` budget caps staged pages and
 * in-flight reads whatever the reader count, and the shared SDK REST manager paces
 * every request under Discord's global and route limits. The queue bounds below
 * scale with it so a higher setting keeps the same headroom per reader.
 */
export const ARCHIVE_LIMITS = {
  concurrency: { minimum: 1, maximum: 32, default: 2 },
  /** Waiting reads and byte reservations allowed per configured reader, never below the floor. */
  queuedPerReader: 16,
  queuedFloor: 128,
  notificationSeconds: { minimum: 10, maximum: 10, default: 10 },
  batchDocuments: 500,
  batchBytes: 4 * 1024 * 1024,
  /**
   * Initial reservation of one reaction-users page: at most 100 user objects. A user
   * with every field Discord returns at its longest (32-character names in 3-byte
   * UTF-8, decoration, nameplate, clan and guild tags) encodes to about 1.3 KB, so a
   * page is about 130 KB; this keeps twice that as headroom. A larger response grows
   * its reservation before staging, and one above `batchBytes` is rejected.
   */
  reactionPageBytes: 256 * 1024,
  /**
   * Logical byte budget for in-flight reads, split into a reaction lane of at most
   * `reactionLaneBytes` and a history lane with the rest. Sized for 32 readers: the
   * reaction lane admits 64 initial page reservations and the history lane 14 page
   * reads, still a small fraction of host memory.
   */
  pipelineBytes: 128 * 1024 * 1024,
  reactionLaneBytes: 16 * 1024 * 1024,
} as const;

export const archiveConcurrencySchema = z
  .number()
  .int()
  .min(ARCHIVE_LIMITS.concurrency.minimum)
  .max(ARCHIVE_LIMITS.concurrency.maximum);

/** The owner-wide bound on queued reads and byte reservations for a reader count. */
export const archiveQueueLimit = (concurrency: number): number =>
  Math.max(ARCHIVE_LIMITS.queuedFloor, concurrency * ARCHIVE_LIMITS.queuedPerReader);

export const archiveNotificationSecondsSchema = z.literal(
  ARCHIVE_LIMITS.notificationSeconds.default,
);

/** Job IDs are `<guildId>:<uuid>`; panel buttons embed them, so the bound keeps custom IDs short. */
export const ARCHIVE_JOB_ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
/** Finished full-backup and periodic-pass records kept per guild. */
export const ARCHIVE_JOB_RECORDS_KEPT = 10;
/** Periodic interval before an operator saves one; `backup_interval_minutes` overrides it. */
export const ARCHIVE_DEFAULT_INTERVAL_MS = 3_600_000;
