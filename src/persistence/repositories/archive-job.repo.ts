import {
  ARCHIVE_JOB_TERMINAL,
  type ArchiveFullBackupJob,
  type ArchiveJob,
  type ArchivePeriodicRecord,
} from '../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../core/archive/progress';
import type { ArchiveOwner, GuildConnection } from '../connection';
import { assertArchiveWriter } from './archive-mutation';

/** Fields a worker may change on its claimed full backup. */
export type ArchiveFullBackupPatch = Partial<
  Pick<ArchiveFullBackupJob, 'status' | 'result' | 'finishedAt' | 'origin'>
>;
/** Claim fields released when a full backup ends. */
export type ArchiveFullBackupReleasedField = 'activeSlot' | 'claimToken' | 'leaseUntil';
/** The archive owner's side of `archive_jobs`: claimed full backups and pass records. */
export interface ArchiveJobRepo {
  getJob(jobId: string): Promise<ArchiveFullBackupJob | undefined>;
  claimJob(token: string, now: number, leaseMs: number): Promise<ArchiveFullBackupJob | undefined>;
  updateJob(
    jobId: string,
    patch: ArchiveFullBackupPatch,
    token?: string,
    unset?: readonly ArchiveFullBackupReleasedField[],
  ): Promise<void>;
  saveJobProgress(
    jobId: string,
    token: string,
    progress: ArchiveProgressSnapshot,
    leaseUntil?: number,
  ): Promise<boolean>;
  insertJobRecord(record: ArchivePeriodicRecord): Promise<void>;
  pruneJobRecords(keep: number): Promise<number>;
  /** Interrupted full backups queue again; those asked to stop end cancelled. */
  recoverInterruptedBackups(): Promise<void>;
  /** Continuity origin of the newest full backup that started. */
  latestBackupOrigin(): Promise<Pick<ArchiveFullBackupJob, 'origin'> | null>;
  hasQueuedBackup(): Promise<boolean>;
  /** Finished full backups whose panel has not shown the result yet and may be retried now. */
  undeliveredBackupResults(now: number, limit: number): Promise<ArchiveFullBackupJob[]>;
  /** Records a failed result delivery; the next attempt waits until `retryAt`. */
  deferBackupNotification(jobId: string, attempts: number, retryAt: number): Promise<void>;
  /** Stops delivering a backup's result to its panel. */
  abandonBackupNotification(jobId: string): Promise<void>;
}
export class MongoArchiveJobRepo implements ArchiveJobRepo {
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
  }
  public async getJob(jobId: string): Promise<ArchiveFullBackupJob | undefined> {
    return (
      (await this.conn.models.ArchiveJob.findOne({ jobId, command: 'full-backup' })
        .lean<ArchiveFullBackupJob>()
        .exec()) ?? undefined
    );
  }
  /**
   * Only full backups are queued; periodic records are written already finished.
   * `startedAt` keeps the first start; `resumedAt` marks this run of the job.
   */
  public async claimJob(
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<ArchiveFullBackupJob | undefined> {
    return (
      (await this.conn.models.ArchiveJob.findOneAndUpdate(
        { command: 'full-backup', status: 'queued', cancelRequested: false },
        [
          {
            $set: {
              status: 'running',
              claimToken: token,
              leaseUntil: now + leaseMs,
              startedAt: { $ifNull: ['$startedAt', now] },
              resumedAt: now,
            },
          },
        ],
        { new: true, sort: { createdAt: 1 } },
      )
        .lean<ArchiveFullBackupJob>()
        .exec()) ?? undefined
    );
  }
  public async updateJob(
    jobId: string,
    patch: ArchiveFullBackupPatch,
    token?: string,
    unset: readonly ArchiveFullBackupReleasedField[] = [],
  ): Promise<void> {
    const result = await this.conn.models.ArchiveJob.updateOne(
      { jobId, command: 'full-backup', ...(token ? { claimToken: token } : {}) },
      {
        $set: patch,
        ...(unset.length === 0
          ? {}
          : { $unset: Object.fromEntries(unset.map((field) => [field, 1])) }),
      },
    ).exec();
    if (!result.matchedCount) throw new Error('Job claim lost');
  }
  /** Saves running progress (and renews the lease) while this process holds the claim. */
  public async saveJobProgress(
    jobId: string,
    token: string,
    progress: ArchiveProgressSnapshot,
    leaseUntil?: number,
  ): Promise<boolean> {
    const result = await this.conn.models.ArchiveJob.updateOne(
      { jobId, command: 'full-backup', status: 'running', claimToken: token },
      {
        $set: { 'result.progress': progress, ...(leaseUntil === undefined ? {} : { leaseUntil }) },
      },
    ).exec();
    return result.matchedCount > 0;
  }
  public async insertJobRecord(record: ArchivePeriodicRecord): Promise<void> {
    await this.conn.models.ArchiveJob.updateOne(
      { _id: record.jobId },
      { $setOnInsert: { ...record, _id: record.jobId } },
      { upsert: true },
    ).exec();
  }
  /**
   * Keeps the newest `keep` finished records. Queued and running jobs are never
   * removed, nor the newest complete full backup (the rebuild tools read its cutoff)
   * or the newest full backup while it is unfinished (it can still be resumed).
   */
  public async pruneJobRecords(keep: number): Promise<number> {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new TypeError('Invalid record retention');
    const jobs = this.conn.models.ArchiveJob;
    const finished = { status: { $nin: ['queued', 'running'] } };
    const protectedIds: string[] = [];
    const latestComplete = await jobs
      .findOne({ command: 'full-backup', status: 'complete' }, { jobId: 1 })
      .sort({ finishedAt: -1 })
      .lean<Pick<ArchiveJob, 'jobId'>>()
      .exec();
    if (latestComplete !== null) protectedIds.push(latestComplete.jobId);
    const latestBackup = await jobs
      .findOne({ command: 'full-backup' }, { jobId: 1, status: 1 })
      .sort({ createdAt: -1 })
      .lean<Pick<ArchiveJob, 'jobId' | 'status'>>()
      .exec();
    if (latestBackup !== null && latestBackup.status !== 'complete')
      protectedIds.push(latestBackup.jobId);
    const kept = await jobs
      .find(finished, { jobId: 1 })
      .sort({ finishedAt: -1, createdAt: -1 })
      .limit(keep)
      .lean<Pick<ArchiveJob, 'jobId'>[]>()
      .exec();
    const result = await jobs
      .deleteMany({
        ...finished,
        jobId: { $nin: [...protectedIds, ...kept.map((job) => job.jobId)] },
      })
      .exec();
    return result.deletedCount;
  }
  public async recoverInterruptedBackups(): Promise<void> {
    await this.conn.models.ArchiveJob.updateMany(
      { command: 'full-backup', status: 'running', cancelRequested: false },
      { $set: { status: 'queued' }, $unset: { claimToken: 1, leaseUntil: 1 } },
    ).exec();
    await this.conn.models.ArchiveJob.updateMany(
      { command: 'full-backup', status: 'running', cancelRequested: true },
      {
        $set: { status: 'cancelled', finishedAt: Date.now() },
        $unset: { activeSlot: 1, claimToken: 1, leaseUntil: 1 },
      },
    ).exec();
  }
  public async latestBackupOrigin(): Promise<Pick<ArchiveFullBackupJob, 'origin'> | null> {
    return this.conn.models.ArchiveJob.findOne(
      { command: 'full-backup', origin: { $exists: true } },
      { origin: 1 },
    )
      .sort({ createdAt: -1 })
      .lean<Pick<ArchiveFullBackupJob, 'origin'>>()
      .exec();
  }
  public async hasQueuedBackup(): Promise<boolean> {
    const queued = await this.conn.models.ArchiveJob.exists({
      command: 'full-backup',
      status: 'queued',
      cancelRequested: false,
    }).exec();
    return queued !== null;
  }
  public async undeliveredBackupResults(
    now: number,
    limit: number,
  ): Promise<ArchiveFullBackupJob[]> {
    return this.conn.models.ArchiveJob.find({
      command: 'full-backup',
      status: { $in: [...ARCHIVE_JOB_TERMINAL] },
      'notification.messageId': { $exists: true },
      $expr: { $ne: [{ $ifNull: ['$notification.deliveredStatus', ''] }, '$status'] },
      $or: [
        { 'notification.retryAt': { $exists: false } },
        { 'notification.retryAt': { $lte: now } },
      ],
    })
      .sort({ finishedAt: -1 })
      .limit(limit)
      .lean<ArchiveFullBackupJob[]>()
      .exec();
  }
  public async deferBackupNotification(
    jobId: string,
    attempts: number,
    retryAt: number,
  ): Promise<void> {
    await this.conn.models.ArchiveJob.updateOne(
      { jobId, command: 'full-backup' },
      { $set: { 'notification.attempts': attempts, 'notification.retryAt': retryAt } },
    ).exec();
  }
  public async abandonBackupNotification(jobId: string): Promise<void> {
    await this.conn.models.ArchiveJob.updateOne(
      { jobId, command: 'full-backup' },
      { $unset: { 'notification.messageId': 1 } },
    ).exec();
  }
}
