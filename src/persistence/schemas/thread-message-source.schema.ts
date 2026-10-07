import { Schema, type InferSchemaType } from 'mongoose';

/** Source attribution survives message deletion without retaining message content. */
export const threadMessageSourceSchema = new Schema({
  bot_id: { type: String, required: true },
  thread_id: { type: String, required: true },
  message_id: { type: String, required: true },
  user_id: { type: String, required: true },
  expires_at: { type: Date, required: true },
});

threadMessageSourceSchema.index({ bot_id: 1, thread_id: 1, message_id: 1 }, { unique: true });
threadMessageSourceSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export type ThreadMessageSourceDoc = InferSchemaType<typeof threadMessageSourceSchema>;
