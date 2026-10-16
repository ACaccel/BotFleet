import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One AI chat request, kept a day so per-member rate limits survive a
 * restart. The TTL index expires rows after the longest limit window.
 */
export const aiUsageSchema = new Schema({
  user_id: { type: String, required: true },
  at: { type: Date, required: true },
});

aiUsageSchema.index({ user_id: 1, at: 1 });
aiUsageSchema.index({ at: 1 }, { expireAfterSeconds: 25 * 60 * 60 });

export type AiUsageDoc = InferSchemaType<typeof aiUsageSchema>;
