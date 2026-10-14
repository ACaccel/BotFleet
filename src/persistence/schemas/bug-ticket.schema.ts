import { Schema, type InferSchemaType } from 'mongoose';

/**
 * A `/bug_report` ticket, stored in the hub guild's database because
 * reports arrive from every guild a bot serves. Metadata only: the
 * conversation lives in the hub forum post and the reporter's DMs.
 */
export const bugTicketSchema = new Schema({
  bot_id: { type: String, required: true },
  /** Sequential per bot; the forum post title carries the bot's name with it. */
  number: { type: Number, required: true },
  reporter_id: { type: String, required: true },
  source_guild_id: { type: String, required: false },
  source_channel_id: { type: String, required: false },
  type: { type: String, required: true, enum: ['bug', 'suggestion', 'other'] },
  title: { type: String, required: true },
  /** The hub forum post; empty only while the post is being created. */
  thread_id: { type: String, required: false, default: '' },
  status: { type: String, required: true, enum: ['open', 'in_progress', 'closed'] },
  created_at: { type: Number, required: true },
  closed_at: { type: Number, required: false },
  closed_by: { type: String, required: false },
  dm_failed: { type: Boolean, required: false, default: false },
});

bugTicketSchema.index({ bot_id: 1, number: 1 }, { unique: true });
bugTicketSchema.index({ bot_id: 1, reporter_id: 1, status: 1 });
bugTicketSchema.index({ thread_id: 1 });

export type BugTicketDoc = InferSchemaType<typeof bugTicketSchema>;
export type BugTicketType = 'bug' | 'suggestion' | 'other';
export type BugTicketStatus = 'open' | 'in_progress' | 'closed';
