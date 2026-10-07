import { Schema } from 'mongoose';
import type {
  ArchiveInboxEntry,
  ArchiveJob,
  ArchiveJournal,
  ArchiveChannel,
} from '../../core/archive/types';

const options = (collection: string) => ({
  collection,
  autoCreate: false,
  autoIndex: false,
  versionKey: false as const,
  suppressReservedKeysWarning: true,
});
export const archiveInboxSchema = new Schema<ArchiveInboxEntry>(
  {
    eventId: { type: String, required: true, unique: true },
    kind: { type: String, required: true },
    messageId: String,
    channelId: String,
    payload: { type: Schema.Types.Mixed, required: true },
    observedAt: { type: Number, required: true },
    state: { type: String, required: true },
    claimToken: String,
    leaseUntil: Number,
    attempts: { type: Number, required: true },
    nextAttemptAt: Number,
    lastError: String,
  },
  options('archive_inbox'),
);
archiveInboxSchema.index({ state: 1, observedAt: 1 });
export const archiveJobSchema = new Schema<ArchiveJob & { _id: string }>(
  {
    _id: { type: String, required: true },
    jobId: { type: String, required: true, unique: true },
    requestId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    command: { type: String, required: true },
    options: { type: Schema.Types.Mixed, required: true },
    runId: String,
    status: { type: String, required: true },
    result: Schema.Types.Mixed,
    cancelRequested: { type: Boolean, default: false },
    deleteRequestedAt: Number,
    createdAt: { type: Number, required: true },
    startedAt: Number,
    finishedAt: Number,
    acceptedAt: Number,
    expiresAt: Number,
    claimToken: String,
    leaseUntil: Number,
    notification: Schema.Types.Mixed,
  },
  options('archive_jobs'),
);
archiveJobSchema.index({ status: 1, createdAt: 1 });
export const archiveJournalSchema = new Schema<ArchiveJournal>(
  {
    journalId: { type: String, required: true, unique: true },
    runId: { type: String, required: true },
    operationId: { type: String, required: true },
    sequence: { type: Number, required: true },
    collection: { type: String, required: true },
    documentId: Schema.Types.Mixed,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    beforeHash: String,
    afterHash: String,
    state: String,
    reason: String,
    dependencies: [String],
    createdAt: Number,
  },
  options('archive_journals'),
);
archiveJournalSchema.index({ runId: 1, sequence: 1 }, { unique: true });
export interface ArchiveRevisionDoc {
  versionObservationId: string;
  messageId: string;
  contentVersionAt: number;
  contentHash: string;
  snapshot: Record<string, unknown>;
}
export const archiveRevisionSchema = new Schema<ArchiveRevisionDoc>(
  {
    messageId: { type: String, required: true },
    contentVersionAt: { type: Number, required: true },
    contentHash: { type: String, required: true },
    versionObservationId: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  options('archive_revisions'),
);
archiveRevisionSchema.index({ messageId: 1, versionObservationId: 1 }, { unique: true });
export interface ArchiveReactionDoc {
  messageId: string;
  emojiKey: string;
  type: number;
  generation: string;
  chunk: number;
  userIds: string[];
  observedAt: number;
}
export const archiveReactionSchema = new Schema<ArchiveReactionDoc>(
  {
    messageId: String,
    emojiKey: String,
    type: Number,
    generation: String,
    chunk: Number,
    userIds: { type: [String], validate: (value: string[]) => value.length <= 1000 },
    observedAt: Number,
  },
  options('archive_reactions'),
);
archiveReactionSchema.index(
  { messageId: 1, emojiKey: 1, type: 1, generation: 1, chunk: 1 },
  { unique: true },
);
export const archiveChannelSchema = new Schema<ArchiveChannel>(
  {
    channelId: { type: String, required: true, unique: true },
    name: String,
    type: Number,
    parentId: String,
    observedAt: Number,
    access: String,
    checkpoint: Schema.Types.Mixed,
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
