import { Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * A sign-up activity posted by `/activity create`. Members join through
 * the announcement's buttons until `expired_at` (the sign-up deadline).
 * `activity_id` is the announcement's message ID. A closed or cancelled
 * activity is kept for a week so roll calls can still use its list; the
 * TTL index on `purge_at` then removes it.
 */
export const activitySchema = new Schema({
  activity_id: { type: String, required: true },
  message_id: { type: String, required: true },
  channel_id: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: false },
  /** Absent on activities created before creators were recorded. */
  creator_id: { type: String, required: false },
  /** Only members holding this role may join. */
  role_id: { type: String, required: false },
  capacity: { type: Number, required: false },
  starts_at: { type: Number, required: false },
  start_notified: { type: Boolean, required: false, default: false },
  expired_at: { type: Number, required: true },
  status: { type: String, required: false, enum: ['open', 'closed', 'cancelled'], default: 'open' },
  participants: [{ type: String, required: true }],
  /** One entry per roll call taken from this activity. */
  attendance: [
    {
      at: { type: Number, required: true },
      present: [{ type: String, required: true }],
      total: { type: Number, required: true },
    },
  ],
  purge_at: { type: Date, required: false },
});

activitySchema.index({ activity_id: 1 });
activitySchema.index({ purge_at: 1 }, { expireAfterSeconds: 0 });

export type ActivityDoc = InferSchemaType<typeof activitySchema> & {
  readonly _id: Types.ObjectId;
};
