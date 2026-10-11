import { mongo, type Connection } from 'mongoose';
import {
  ARCHIVE_GAP_ACCESS,
  ARCHIVE_JOB_ACTIVE,
  ARCHIVE_JOB_RESUMABLE,
  isArchiveGapAccess,
  type ArchiveChannel,
  type ArchiveCoverage,
  type ArchiveFullBackupJob,
  type ArchiveGapChannel,
  type ArchiveInboxEntry,
  type ArchiveJob,
  type ArchiveTerminalStatus,
} from '../../core/archive/types';

/** A start approval shown on one panel, bound to the operator who requested it. */
export interface ArchiveConfirmation {
  _id: string;
  guildId: string;
  userId: string;
  channelId: string;
  messageId: string;
  action: 'full-backup';
  requestId: string;
  createdAt: number;
  expiresAt: number;
  /** A Date so the TTL index can remove the record. */
  purgeAt: Date;
  consumedAt?: number;
  cancelledAt?: number;
}

/** The panel message that follows a full backup. */
export interface ArchivePanelRef {
  readonly channelId: string;
  readonly messageId: string;
}

/** Outcome of queueing a stopped or failed backup again. */
export type ArchiveRequeueOutcome = 'requeued' | 'not-resumable' | 'slot-taken';

/**
 * Durable state behind Discord archive control for one guild: start approvals
 * (`archive_control_confirmations`), full-backup jobs and the panel each follows
 * (`archive_jobs`), and the read models `/archive status` shows. Every query is
 * scoped to the guild the repository was built for.
 */
export interface ArchiveControlRepo {
  /** Indexes the single-active-backup guarantee and approval expiry rely on. */
  ensureIndexes(): Promise<void>;
  latestFullBackup(): Promise<ArchiveFullBackupJob | undefined>;
  findFullBackup(jobId: string): Promise<ArchiveFullBackupJob | undefined>;
  /** A full backup by its document ID (`<guildId>:<requestId>`). */
  findJobById(id: string): Promise<ArchiveFullBackupJob | undefined>;
  /** Creates the job unless one exists; `false` when the active slot is taken. */
  insertFullBackup(job: ArchiveFullBackupJob & { _id: string }): Promise<boolean>;
  /** Stops a queued backup at once and marks a running one for a cooperative stop. */
  requestStop(jobId: string, now: number): Promise<void>;
  requeueFullBackup(
    jobId: string,
    panel: ArchivePanelRef & { view: 'progress' },
  ): Promise<ArchiveRequeueOutcome>;
  setPanel(jobId: string, panel: ArchivePanelRef & { view: 'progress' | 'gaps' }): Promise<void>;
  /** Detaches `messageId` from the job; a panel that moved elsewhere stays attached. */
  releasePanel(jobId: string, messageId: string): Promise<void>;
  /** Records the terminal status the panel `messageId` shows. */
  markPanelDelivered(
    jobId: string,
    messageId: string,
    status: ArchiveTerminalStatus,
  ): Promise<void>;
  /** Full-backup and periodic records, newest first. */
  recentRecords(limit: number): Promise<ArchiveJob[]>;
  insertConfirmation(confirmation: ArchiveConfirmation): Promise<void>;
  findConfirmation(token: string): Promise<ArchiveConfirmation | undefined>;
  /** Consumes an unexpired, unused approval; `false` when another request won. */
  consumeConfirmation(token: string): Promise<boolean>;
  isConfirmationConsumed(token: string): Promise<boolean>;
  cancelConfirmation(token: string): Promise<void>;
  /** Stored sources the bot cannot back up (`denied`, `unknown`, `deleted`). */
  countGapChannels(): Promise<number>;
  listGapChannels(skip: number, limit: number): Promise<ArchiveGapChannel[]>;
  coverage(): Promise<ArchiveCoverage>;
  /** Live events waiting for or under reconciliation. */
  openInboxCount(): Promise<number>;
  /** Live events abandoned after repeated reconciliation failures. */
  deadLetterCount(): Promise<number>;
}

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof mongo.MongoServerError && error.code === 11000;
/** Sources the gap views list: every stored channel the bot cannot back up. */
const gapFilter: mongo.Filter<ArchiveChannel> = {
  access: { $in: [...ARCHIVE_GAP_ACCESS] },
  channelId: { $not: /^guild:/ },
};
/** Databases whose control indexes this process already ensured. */
const indexedDatabases = new WeakSet<object>();

export class MongoArchiveControlRepo implements ArchiveControlRepo {
  public constructor(
    private readonly connection: Connection,
    private readonly guildId: string,
  ) {
    if (connection.db === undefined)
      throw new TypeError('Archive control requires an open database');
  }

  private jobs() {
    return this.connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
  }

  private backups() {
    return this.connection.collection<ArchiveFullBackupJob & { _id: string }>('archive_jobs');
  }

  private confirmations() {
    return this.connection.collection<ArchiveConfirmation>('archive_control_confirmations');
  }

  private channels() {
    return this.connection.collection<ArchiveChannel>('archive_channels');
  }

  private inbox() {
    return this.connection.collection<ArchiveInboxEntry>('archive_inbox');
  }

  /**
   * The worker also creates the job index at startup; creating it here keeps a
   * confirmation from racing a worker that has not opened the guild yet.
   */
  public async ensureIndexes(): Promise<void> {
    const db = this.connection.db;
    if (db === undefined || indexedDatabases.has(db)) return;
    await this.jobs().createIndex(
      { activeSlot: 1 },
      { unique: true, partialFilterExpression: { activeSlot: { $exists: true } } },
    );
    await this.confirmations().createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    indexedDatabases.add(db);
  }

  public async latestFullBackup(): Promise<ArchiveFullBackupJob | undefined> {
    return (
      (await this.backups().findOne(
        { guildId: this.guildId, command: 'full-backup' },
        { sort: { createdAt: -1 } },
      )) ?? undefined
    );
  }

  public async findFullBackup(jobId: string): Promise<ArchiveFullBackupJob | undefined> {
    return (
      (await this.backups().findOne({ jobId, guildId: this.guildId, command: 'full-backup' })) ??
      undefined
    );
  }

  public async findJobById(id: string): Promise<ArchiveFullBackupJob | undefined> {
    return (await this.backups().findOne({ _id: id, guildId: this.guildId })) ?? undefined;
  }

  public async insertFullBackup(job: ArchiveFullBackupJob & { _id: string }): Promise<boolean> {
    try {
      await this.backups().updateOne({ _id: job._id }, { $setOnInsert: job }, { upsert: true });
      return true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return false;
    }
  }

  public async requestStop(jobId: string, now: number): Promise<void> {
    await this.backups().updateOne(
      {
        jobId,
        guildId: this.guildId,
        command: 'full-backup',
        status: { $in: [...ARCHIVE_JOB_ACTIVE] },
      },
      [
        {
          $set: {
            cancelRequested: true,
            status: { $cond: [{ $eq: ['$status', 'queued'] }, 'cancelled', '$status'] },
            finishedAt: { $cond: [{ $eq: ['$status', 'queued'] }, now, '$finishedAt'] },
            activeSlot: { $cond: [{ $eq: ['$status', 'queued'] }, '$$REMOVE', '$activeSlot'] },
          },
        },
      ],
    );
  }

  public async requeueFullBackup(
    jobId: string,
    panel: ArchivePanelRef & { view: 'progress' },
  ): Promise<ArchiveRequeueOutcome> {
    try {
      const resumed = await this.backups().updateOne(
        { jobId, guildId: this.guildId, status: { $in: [...ARCHIVE_JOB_RESUMABLE] } },
        {
          $set: {
            status: 'queued',
            cancelRequested: false,
            activeSlot: 'full-backup',
            notification: panel,
          },
          $unset: { finishedAt: 1, claimToken: 1, leaseUntil: 1 },
        },
      );
      return resumed.matchedCount === 0 ? 'not-resumable' : 'requeued';
    } catch (error) {
      if (isDuplicateKey(error)) return 'slot-taken';
      throw error;
    }
  }

  public async setPanel(
    jobId: string,
    panel: ArchivePanelRef & { view: 'progress' | 'gaps' },
  ): Promise<void> {
    await this.backups().updateOne(
      { jobId, guildId: this.guildId, command: 'full-backup' },
      { $set: { notification: panel } },
    );
  }

  public async releasePanel(jobId: string, messageId: string): Promise<void> {
    await this.backups().updateOne(
      { jobId, guildId: this.guildId, 'notification.messageId': messageId },
      { $unset: { 'notification.messageId': 1 } },
    );
  }

  public async markPanelDelivered(
    jobId: string,
    messageId: string,
    status: ArchiveTerminalStatus,
  ): Promise<void> {
    await this.backups().updateOne(
      { jobId, guildId: this.guildId, 'notification.messageId': messageId },
      { $set: { 'notification.deliveredStatus': status } },
    );
  }

  public async recentRecords(limit: number): Promise<ArchiveJob[]> {
    return this.jobs()
      .find({ guildId: this.guildId, command: { $in: ['full-backup', 'periodic'] } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  public async insertConfirmation(confirmation: ArchiveConfirmation): Promise<void> {
    await this.confirmations().insertOne(confirmation);
  }

  public async findConfirmation(token: string): Promise<ArchiveConfirmation | undefined> {
    return (await this.confirmations().findOne({ _id: token, guildId: this.guildId })) ?? undefined;
  }

  public async consumeConfirmation(token: string): Promise<boolean> {
    const consumed = await this.confirmations().updateOne(
      {
        _id: token,
        consumedAt: { $exists: false },
        cancelledAt: { $exists: false },
        expiresAt: { $gt: Date.now() },
      },
      { $set: { consumedAt: Date.now() } },
    );
    return consumed.modifiedCount > 0;
  }

  public async isConfirmationConsumed(token: string): Promise<boolean> {
    const confirmation = await this.confirmations().findOne({ _id: token, guildId: this.guildId });
    return confirmation?.consumedAt !== undefined;
  }

  public async cancelConfirmation(token: string): Promise<void> {
    await this.confirmations().updateOne(
      { _id: token, consumedAt: { $exists: false } },
      { $set: { cancelledAt: Date.now() } },
    );
  }

  public async countGapChannels(): Promise<number> {
    return this.channels().countDocuments(gapFilter, { maxTimeMS: 5000 });
  }

  public async listGapChannels(skip: number, limit: number): Promise<ArchiveGapChannel[]> {
    const rows = await this.channels()
      .find(gapFilter, { projection: { _id: 0, channelId: 1, name: 1, access: 1 } })
      .sort({ access: 1, name: 1, channelId: 1 })
      .skip(skip)
      .limit(limit)
      .maxTimeMS(5000)
      .toArray();
    return rows.flatMap((row) =>
      isArchiveGapAccess(row.access)
        ? [{ channelId: row.channelId, name: row.name ?? '', access: row.access }]
        : [],
    );
  }

  public async coverage(): Promise<ArchiveCoverage> {
    const rows = await this.channels()
      .aggregate<{ _id: ArchiveChannel['access']; count: number }>(
        [
          { $match: { channelId: { $not: /^guild:/ } } },
          { $group: { _id: '$access', count: { $sum: 1 } } },
        ],
        { maxTimeMS: 5000 },
      )
      .toArray();
    const count = (access: ArchiveChannel['access']): number =>
      rows.find((row) => row._id === access)?.count ?? 0;
    return {
      readable: count('readable'),
      gaps: { denied: count('denied'), deleted: count('deleted'), unknown: count('unknown') },
    };
  }

  public async openInboxCount(): Promise<number> {
    return this.inbox().countDocuments(
      { state: { $in: ['pending', 'processing'] } },
      { maxTimeMS: 5000 },
    );
  }

  public async deadLetterCount(): Promise<number> {
    return this.inbox().countDocuments({ state: 'dead' }, { maxTimeMS: 5000 });
  }
}
