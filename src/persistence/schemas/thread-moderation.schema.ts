import { Schema, type InferSchemaType } from 'mongoose';

const claimNoticeSchema = new Schema(
  {
    admin_id: { type: String, required: true },
    channel_id: { type: String, required: true },
    message_id: { type: String, required: true },
  },
  { _id: false },
);
const claimSchema = new Schema(
  {
    id: { type: String, required: true },
    applicant_id: { type: String, required: true },
    owner_id: { type: String, required: true },
    reason: { type: String, required: true },
    requested_at: { type: Number, required: true },
    expires_at: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'delivery_failed'],
      required: true,
    },
    notices: { type: [claimNoticeSchema], required: true, default: [] },
    reviewed_by: String,
    reviewed_at: Number,
    delivery_completed_at: Number,
  },
  { _id: false },
);
const managementLogSchema = new Schema(
  {
    actor_id: { type: String, required: true },
    user_id: { type: String, required: true },
    action: { type: String, enum: ['grant', 'revoke', 'approve', 'reject'], required: true },
    at: { type: Number, required: true },
    claim_id: String,
  },
  { _id: false },
);

/** Guild isolation comes from the database; each bot owns its thread restrictions. */
export const threadModerationSchema = new Schema({
  bot_id: { type: String, required: true },
  thread_id: { type: String, required: true },
  manager_ids: { type: [String], required: true, default: [] },
  claims: { type: [claimSchema], required: true, default: [] },
  management_log: { type: [managementLogSchema], required: true, default: [] },
  blocked_user_ids: { type: [String], required: true, default: [] },
});

threadModerationSchema.index({ bot_id: 1, thread_id: 1 }, { unique: true });

export type ThreadModerationDoc = InferSchemaType<typeof threadModerationSchema>;
