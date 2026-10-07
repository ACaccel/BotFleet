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
