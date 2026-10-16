import { Schema, type InferSchemaType } from 'mongoose';

/** Records expire this long after their last update; a deployment thread is long finished by then. */
const NOTIFICATION_THREAD_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The Discord message that carries one relayed notification thread, so later
 * updates for the same route and caller key edit it, also after a restart.
 * Stored in the route guild's database; holds IDs only, never the message text.
 */
export const notificationThreadSchema = new Schema({
  bot_id: { type: String, required: true },
  route: { type: String, required: true },
  /** Caller-chosen idempotency key for the thread. */
  thread_key: { type: String, required: true },
  channel_id: { type: String, required: true },
  message_id: { type: String, required: true },
  updated_at: { type: Date, required: true },
});

notificationThreadSchema.index({ bot_id: 1, route: 1, thread_key: 1 }, { unique: true });
notificationThreadSchema.index(
  { updated_at: 1 },
  { expireAfterSeconds: NOTIFICATION_THREAD_TTL_SECONDS },
);

export type NotificationThreadDoc = InferSchemaType<typeof notificationThreadSchema>;
