/**
 * Auto-reply pair: when a user message matches `input` exactly, the bot
 * posts `reply`. Owned per guild.
 */
import { Schema, type InferSchemaType, type Types } from 'mongoose';

export const replySchema = new Schema({
  input: { type: String, required: true },
  reply: { type: String, required: true },
  /** Member who added the pair; absent on pairs added before it was recorded. */
  created_by: { type: String, required: false },
});

export type ReplyDoc = InferSchemaType<typeof replySchema> & {
  readonly _id: Types.ObjectId;
};
