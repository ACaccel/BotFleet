/**
 * The request contract of `PUT /notifications/:route/:key`. Every display
 * string comes from the caller verbatim; only status labels are translated.
 */
import { z } from 'zod';

/** Caller-chosen idempotency key naming one notification thread. */
export const THREAD_KEY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const STAGE_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
const NOTIFICATION_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

export type StageState = (typeof STAGE_STATES)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

const httpUrl = z
  .string()
  .max(500)
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), 'must be an http(s) URL');

/** Bounds keep the rendered embed within Discord's limits. */
export const NotificationSchema = z
  .object({
    title: z.string().min(1).max(256),
    description: z.string().max(3000).optional(),
    url: httpUrl.optional(),
    stages: z
      .array(z.object({ label: z.string().min(1).max(100), state: z.enum(STAGE_STATES) }).strict())
      .max(10),
    status: z.enum(NOTIFICATION_STATUSES),
    summary: z.string().max(500).optional(),
  })
  .strict();

export type Notification = z.infer<typeof NotificationSchema>;
