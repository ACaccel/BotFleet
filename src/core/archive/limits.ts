import { z } from 'zod';

/** Shared admission and notification bounds; benchmark trials do not change operator defaults. */
export const ARCHIVE_LIMITS = {
  concurrency: { minimum: 1, maximum: 8, default: 2 },
  notificationSeconds: { minimum: 10, maximum: 10, default: 10 },
  batchDocuments: 500,
  batchBytes: 4 * 1024 * 1024,
  pipelineBytes: 64 * 1024 * 1024,
} as const;

export const archiveConcurrencySchema = z
  .number()
  .int()
  .min(ARCHIVE_LIMITS.concurrency.minimum)
  .max(ARCHIVE_LIMITS.concurrency.maximum);

export const archiveNotificationSecondsSchema = z.literal(
  ARCHIVE_LIMITS.notificationSeconds.default,
);

/** Job IDs are `<guildId>:<uuid>`; panel buttons embed them, so the bound keeps custom IDs short. */
export const ARCHIVE_JOB_ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
/** Finished full-backup and periodic-pass records kept per guild. */
export const ARCHIVE_JOB_RECORDS_KEPT = 10;
/** Periodic interval before an operator saves one; `backup_interval_minutes` overrides it. */
export const ARCHIVE_DEFAULT_INTERVAL_MS = 3_600_000;
