import { Schema } from 'mongoose';
import {
  ARCHIVE_CHANNEL_ACCESS,
  ARCHIVE_JOB_COMMANDS,
  ARCHIVE_JOB_STATUSES,
  type ArchiveInboxDocument,
  type ArchiveJob,
  type ArchiveChannel,
} from '../../core/archive/types';

const options = (collection: string) => ({
  collection,
  autoCreate: false,
  autoIndex: false,
  versionKey: false as const,
  suppressReservedKeysWarning: true,
});
export const archiveInboxSchema = new Schema<ArchiveInboxDocument>(
  {
    eventId: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ['snapshot', 'delete', 'reaction', 'gap'] },
    messageId: String,
    channelId: String,
    payload: { type: Schema.Types.Mixed, required: true },
    observedAt: { type: Number, required: true },
    state: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'complete', 'dead'],
    },
    claimToken: String,
    leaseUntil: Number,
    attempts: { type: Number, required: true },
    claims: Number,
    firstFailedAt: Number,
    nextAttemptAt: Number,
    lastError: String,
    deadAt: Date,
    tracedRunId: String,
  },
  options('archive_inbox'),
);
archiveInboxSchema.index({ state: 1, observedAt: 1 });
/** Dead letters are kept for inspection, then expire. */
const ARCHIVE_DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60;
archiveInboxSchema.index({ deadAt: 1 }, { expireAfterSeconds: ARCHIVE_DEAD_LETTER_TTL_SECONDS });
export const archiveJobSchema = new Schema<ArchiveJob & { _id: string }>(
  {
    _id: { type: String, required: true },
    jobId: { type: String, required: true, unique: true },
    requestId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    command: { type: String, required: true, enum: ARCHIVE_JOB_COMMANDS },
    options: { type: Schema.Types.Mixed, required: true },
    runId: String,
    status: { type: String, required: true, enum: ARCHIVE_JOB_STATUSES },
    result: Schema.Types.Mixed,
    cancelRequested: { type: Boolean, default: false },
    activeSlot: { type: String, enum: ['full-backup'] },
    origin: Schema.Types.Mixed,
    resumedAt: Number,
    createdAt: { type: Number, required: true },
    startedAt: Number,
    finishedAt: Number,
    claimToken: String,
    leaseUntil: Number,
    notification: Schema.Types.Mixed,
  },
  options('archive_jobs'),
);
archiveJobSchema.index({ status: 1, createdAt: 1 });
/** At most one queued or running full backup per guild. */
archiveJobSchema.index(
  { activeSlot: 1 },
  { unique: true, partialFilterExpression: { activeSlot: { $exists: true } } },
);
/**
 * One chunk of a reaction's member list. `emojiKey` is the reaction identity
 * (`reactionKey`: custom emoji ID or Unicode emoji); `channelId` is the message's
 * channel, so readers can filter by visibility without loading the message.
 */
export interface ArchiveReactionDoc {
  messageId: string;
  channelId: string;
  emojiKey: string;
  type: 0 | 1;
  generation: string;
  chunk: number;
  userIds: string[];
  observedAt: number;
}
export const archiveReactionSchema = new Schema<ArchiveReactionDoc>(
  {
    messageId: { type: String, required: true },
    channelId: { type: String, required: true },
    emojiKey: { type: String, required: true },
    type: { type: Number, required: true, enum: [0, 1] },
    generation: { type: String, required: true },
    chunk: { type: Number, required: true, min: 0 },
    userIds: {
      type: [String],
      required: true,
      validate: (value: string[]) => value.length <= 1000,
    },
    observedAt: { type: Number, required: true },
  },
  options('archive_reactions'),
);
archiveReactionSchema.index(
  { messageId: 1, emojiKey: 1, type: 1, generation: 1, chunk: 1 },
  { unique: true },
);
/** Garbage collection selects old chunks by age, then groups them by message. */
archiveReactionSchema.index({ observedAt: 1, messageId: 1 });
export const archiveChannelSchema = new Schema<ArchiveChannel>(
  {
    channelId: { type: String, required: true, unique: true },
    name: String,
    type: Number,
    parentId: String,
    observedAt: Number,
    access: { type: String, required: true, enum: ARCHIVE_CHANNEL_ACCESS },
    everyoneCanView: Boolean,
    checkpoints: Schema.Types.Mixed,
    discovery: Schema.Types.Mixed,
  },
  options('archive_channels'),
);
export interface ArchiveLeaseDoc {
  key: string;
  ownerId: string;
  acquiredAt: number;
}
export const archiveLeaseSchema = new Schema<ArchiveLeaseDoc>(
  {
    key: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true },
    acquiredAt: { type: Number, required: true },
  },
  options('archive_leases'),
);
