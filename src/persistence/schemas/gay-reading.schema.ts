import { Schema, type InferSchemaType } from 'mongoose';

/** Scores only: archive messages and member IDs never enter this collection. */
export const gayReadingSchema = new Schema(
  {
    _id: { type: String, required: true },
    percent: { type: Number, required: true, min: 0, max: 100 },
    commentKey: {
      type: String,
      required: true,
      match: /^replies:gay\.(single|pair)_(low|mid|high)_[12]$/,
    },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'gay_readings' },
);

gayReadingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type GayReadingDoc = InferSchemaType<typeof gayReadingSchema>;
