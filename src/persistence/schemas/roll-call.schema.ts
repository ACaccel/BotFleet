import { Schema, type InferSchemaType } from 'mongoose';

/**
 * A `/roll_call` message: who was called, who has checked in, and when it
 * closes. Kept a week after closing (TTL on `purge_at`).
 */
export const rollCallSchema = new Schema({
  message_id: { type: String, required: true },
  channel_id: { type: String, required: true },
  creator_id: { type: String, required: true },
  /** How the bot named itself when posting, so later edits keep the same title. */
  persona: { type: String, required: false },
  targets: [{ type: String, required: true }],
  present: [{ type: String, required: true }],
  /** The activity whose participants were called; its post shows the attendance. */
  activity_id: { type: String, required: false },
  deadline: { type: Number, required: false },
  closed: { type: Boolean, required: true, default: false },
  purge_at: { type: Date, required: false },
});

rollCallSchema.index({ message_id: 1 }, { unique: true });
rollCallSchema.index({ purge_at: 1 }, { expireAfterSeconds: 0 });

export type RollCallDoc = InferSchemaType<typeof rollCallSchema>;
