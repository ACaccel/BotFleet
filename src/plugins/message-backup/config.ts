import { z } from 'zod';
import {
  ARCHIVE_DEFAULT_INTERVAL_MS,
  ARCHIVE_LIMITS,
  archiveConcurrencySchema,
} from '../../core/archive/limits';
import { ArchivePolicySchema } from '../../core/archive/policy';

/** Source policy is parsed separately by the domain policy schema. */
export const archiveRuntimeSchema = z
  .object({
    concurrency: archiveConcurrencySchema.default(ARCHIVE_LIMITS.concurrency.default),
    overlap_minutes: z.number().int().min(1).max(1440).default(60),
    job_poll_seconds: z.number().int().min(1).max(300).default(5),
    max_pending_events: z.number().int().min(1).max(10000).default(1000),
    max_inbox_bytes: z.number().int().positive().max(10_000_000_000).default(1_000_000_000),
    storage: z
      .object({
        budget_bytes: z.number().int().positive().default(100_000_000_000),
        background_limit_bytes: z.number().int().positive().default(85_000_000_000),
        reserve_bytes: z.number().int().positive().default(5_000_000_000),
        mongo_data_root: z.string().min(1).optional(),
        additional_roots: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.storage.background_limit_bytes >= value.storage.budget_bytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storage', 'background_limit_bytes'],
        message: 'Background limit must be below the project budget',
      });
    }
    if (value.storage.reserve_bytes >= value.storage.background_limit_bytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storage', 'reserve_bytes'],
        message: 'Reserve must be below the background limit',
      });
    }
  });

export type ArchiveRuntimeConfig = z.infer<typeof archiveRuntimeSchema>;

/** Composition and deploy preparation validate exactly the same archive settings. */
export function parseArchiveSettings(input: {
  backupServers: readonly string[];
  backupIntervalMs?: number;
  policy?: unknown;
  runtime?: unknown;
}): {
  interval: number;
  config: ArchiveRuntimeConfig;
  policy: z.infer<typeof ArchivePolicySchema>;
} {
  const interval = input.backupIntervalMs ?? ARCHIVE_DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(interval) || interval <= 0 || interval > 2_147_483_647)
    throw new TypeError('Invalid archive backup interval');
  if (
    input.policy !== undefined &&
    (typeof input.policy !== 'object' || input.policy === null || Array.isArray(input.policy))
  )
    throw new TypeError('Archive policy must be an object');
  return {
    interval,
    config: archiveRuntimeSchema.parse(input.runtime ?? {}),
    policy: ArchivePolicySchema.parse({
      ...(typeof input.policy === 'object' && input.policy !== null ? input.policy : {}),
      guildIds: [...input.backupServers],
    }),
  };
}
