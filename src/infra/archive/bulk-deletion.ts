import { randomUUID } from 'node:crypto';
import type { Collection, Connection } from 'mongoose';
import { z } from 'zod';
import { ArchiveControlService } from './control';
import { ARCHIVE_PROCESS_ID, isTerminatedArchiveProcess } from './owner';

const actorSchema = z
  .object({
    userId: z.string().regex(/^\d{1,20}$/),
    channelId: z.string().regex(/^\d{1,20}$/),
    messageId: z.string().regex(/^\d{1,20}$/),
  })
  .strict();
const targetSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
type Actor = z.infer<typeof actorSchema>;
type Kind = 'jobs' | 'plans';
type Outcome = 'deleted' | 'pending' | 'protected' | 'failed';
interface PublicNotification {
  channelId: string;
  messageId: string;
}
interface Review {
  reviewId: string;
  kind: Kind;
  total: number;
  eligible: number;
  protected: number;
  active: number;
  expiresAt: number;
}
interface Progress {
  reviewId: string;
  kind: Kind;
  total: number;
  deleted: number;
  pending: number;
  protected: number;
  failed: number;
  remaining: number;
  complete: boolean;
}
interface ItemResult {
  kind: Kind;
  id: string;
  outcome: Outcome;
  notification?: PublicNotification;
}
interface Batch extends Review {
  _id: string;
  guildId: string;
  actor: Actor;
  createdAt: number;
  state: 'reviewing' | 'ready' | 'running' | 'complete' | 'failed' | 'expired';
  ownerId?: string;
  executionToken?: string;
  result?: Progress;
}
interface Item {
  _id: string;
  reviewId: string;
  sequence: number;
  id?: string;
  state: 'pending' | 'processing' | 'complete';
  outcome?: Outcome;
  notification?: PublicNotification;
}
const executions = new Set<string>();
const sameActor = (left: Actor, right: Actor): boolean =>
  left.userId === right.userId &&
  left.channelId === right.channelId &&
  left.messageId === right.messageId;
const protectedErrors = new Set([
  'Applied repair recovery cannot be deleted',
  'Repair plan cannot be deleted while work is active',
]);
const missingErrors = new Set([
  'Unknown repair manifest for this guild',
  'Unknown archive job for this guild',
]);

/** A durable exact-identity snapshot separates consent from changing archive lists. */
export class ArchiveBulkDeletionService {
  private readonly control: ArchiveControlService;
  private readonly batches: Collection<Batch>;
  private readonly items: Collection<Item>;
  public constructor(
    private readonly connection: Connection,
    private readonly guildId: string,
  ) {
    z.string()
      .regex(/^\d{1,20}$/)
      .parse(guildId);
    this.control = new ArchiveControlService(connection, guildId);
    this.batches = connection.collection<Batch>('archive_bulk_deletions');
    this.items = connection.collection<Item>('archive_bulk_deletion_items');
  }

  private async prepare(): Promise<void> {
    await this.items.createIndex({ reviewId: 1, sequence: 1 }, { unique: true });
    // Claim cleanup before removing items so an accepted execution keeps its snapshot.
    const now = Date.now();
    const expired = await this.batches
      .find({
        guildId: this.guildId,
        $or: [
          { state: 'ready', expiresAt: { $lte: now } },
          { state: { $in: ['complete', 'failed', 'reviewing', 'expired'] } },
        ],
        createdAt: { $lt: now - 86_400_000 },
      })
      .limit(25)
      .toArray();
    for (const batch of expired) {
      if (
        batch.state === 'reviewing' &&
        (batch.ownerId === undefined ||
          batch.ownerId === ARCHIVE_PROCESS_ID ||
          !(await isTerminatedArchiveProcess(this.connection, batch.ownerId).catch(() => false)))
      )
        continue;
      const claimed = await this.batches.updateOne(
        {
          _id: batch._id,
          guildId: this.guildId,
          state: batch.state,
          createdAt: { $lt: now - 86_400_000 },
          ...(batch.state === 'ready' ? { expiresAt: { $lte: now } } : {}),
          ...(batch.state === 'reviewing' ? { ownerId: batch.ownerId } : {}),
        },
        { $set: { state: 'expired' } },
      );
      if (claimed.matchedCount !== 1) continue;
      await this.items.deleteMany({ reviewId: batch.reviewId });
      await this.batches.deleteOne({ _id: batch._id, state: 'expired' });
    }
  }

  private async batch(reviewId: string, actor: Actor): Promise<Batch> {
    z.string().uuid().parse(reviewId);
    actorSchema.parse(actor);
    const batch = await this.batches.findOne({ _id: reviewId, guildId: this.guildId });
    if (batch === null) throw new Error('Unknown archive deletion review');
    if (!sameActor(batch.actor, actor))
      throw new Error('Archive deletion review belongs to another actor');
    return batch;
  }

  public async review(kind: Kind, actor: Actor): Promise<Review> {
    z.enum(['jobs', 'plans']).parse(kind);
    actorSchema.parse(actor);
    await this.prepare();
    const reviewId = randomUUID();
    const createdAt = Date.now();
    const batch: Batch = {
      _id: reviewId,
      reviewId,
      guildId: this.guildId,
      actor: { ...actor },
      kind,
      createdAt,
      expiresAt: createdAt + 300_000,
      state: 'reviewing',
      ownerId: ARCHIVE_PROCESS_ID,
      total: 0,
      eligible: 0,
      protected: 0,
      active: 0,
    };
    await this.batches.insertOne(batch);
    const source = this.connection.collection(
      kind === 'jobs' ? 'archive_jobs' : 'archive_repair_runs',
    );
    const cursor = source
      .find(
        {
          guildId: this.guildId,
        },
        { projection: kind === 'jobs' ? { jobId: 1, status: 1 } : { _id: 1 } },
      )
      .sort({ _id: 1 })
      .batchSize(100);
    let pending: Item[] = [];
    try {
      for await (const document of cursor) {
        const parsed = targetSchema.safeParse(kind === 'jobs' ? document['jobId'] : document._id);
        const id = parsed.success ? parsed.data : undefined;
        const eligible =
          id !== undefined && (kind === 'jobs' || (await this.control.canDeletePlan(id)));
        if (kind === 'jobs' && ['queued', 'running'].includes(String(document['status'])))
          batch.active += 1;
        const sequence = batch.total++;
        batch[eligible ? 'eligible' : 'protected'] += 1;
        pending.push({
          _id: `${reviewId}:${sequence}`,
          reviewId,
          sequence,
          ...(id === undefined ? {} : { id }),
          state: eligible ? 'pending' : 'complete',
          ...(eligible ? {} : { outcome: 'protected' as const }),
        });
        if (pending.length >= 100) {
          await this.items.insertMany(pending);
          pending = [];
        }
      }
      if (pending.length > 0) await this.items.insertMany(pending);
      batch.expiresAt = Date.now() + 300_000;
      await this.batches.updateOne(
        { _id: reviewId, state: 'reviewing' },
        {
          $set: {
            state: 'ready',
            total: batch.total,
            eligible: batch.eligible,
            protected: batch.protected,
            active: batch.active,
            expiresAt: batch.expiresAt,
          },
        },
      );
    } catch (error) {
      await this.batches
        .updateOne({ _id: reviewId, state: 'reviewing' }, { $set: { state: 'failed' } })
        .catch(() => undefined);
      throw error;
    } finally {
      await cursor.close();
    }
    return {
      reviewId,
      kind,
      total: batch.total,
      eligible: batch.eligible,
      protected: batch.protected,
      active: batch.active,
      expiresAt: batch.expiresAt,
    };
  }

  public async progress(reviewId: string, actor: Actor): Promise<Progress> {
    const batch = await this.batch(reviewId, actor);
    if (batch.state === 'complete' && batch.result !== undefined) return batch.result;
    const outcomes = await this.items
      .aggregate<{
        _id: Outcome;
        count: number;
      }>([
        { $match: { reviewId, state: 'complete' } },
        { $group: { _id: '$outcome', count: { $sum: 1 } } },
      ])
      .toArray();
    const counts: Record<Outcome, number> = { deleted: 0, pending: 0, protected: 0, failed: 0 };
    for (const result of outcomes) if (result._id in counts) counts[result._id] = result.count;
    return {
      reviewId,
      kind: batch.kind,
      total: batch.total,
      ...counts,
      remaining: Math.max(
        0,
        batch.total - Object.values(counts).reduce((sum, value) => sum + value, 0),
      ),
      complete: false,
    };
  }

  private notification(value: unknown, actor: Actor): PublicNotification | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      candidate['channelId'] !== actor.channelId ||
      typeof candidate['messageId'] !== 'string' ||
      !/^\d{1,20}$/.test(candidate['messageId'])
    )
      return undefined;
    return { channelId: actor.channelId, messageId: candidate['messageId'] };
  }

  private async captureNotification(
    batch: Batch,
    item: Item,
  ): Promise<PublicNotification | undefined> {
    if (item.notification !== undefined) return item.notification;
    const job = await this.connection.collection('archive_jobs').findOne(
      {
        guildId: this.guildId,
        ...(batch.kind === 'jobs'
          ? { jobId: item.id }
          : {
              $or: [{ runId: item.id }, { 'result.runId': item.id }],
              'notification.supersededAt': { $exists: false },
            }),
      },
      { sort: { createdAt: -1 }, projection: { notification: 1 } },
    );
    const notification = this.notification(job?.['notification'], batch.actor);
    if (notification !== undefined || batch.kind === 'jobs') return notification;
    const run = await this.connection
      .collection<{ _id: string; publicMessage?: PublicNotification }>('archive_repair_runs')
      .findOne({ _id: item.id, guildId: this.guildId }, { projection: { publicMessage: 1 } });
    return this.notification(run?.publicMessage, batch.actor);
  }

  public async execute(
    reviewId: string,
    actor: Actor,
    onProgress?: (progress: Progress) => Promise<void>,
    onItem?: (item: ItemResult) => Promise<void>,
  ): Promise<Progress> {
    const batch = await this.batch(reviewId, actor);
    if (batch.state === 'complete' && batch.result !== undefined) return batch.result;
    if (
      !['ready', 'running'].includes(batch.state) ||
      (batch.state === 'ready' && batch.expiresAt <= Date.now())
    )
      throw new Error('Archive deletion review expired');
    const key = this.guildId + ':' + reviewId;
    if (executions.has(key)) throw new Error('Archive deletion batch is already running');
    executions.add(key);
    try {
      if (
        batch.state === 'running' &&
        batch.ownerId !== ARCHIVE_PROCESS_ID &&
        (batch.ownerId === undefined ||
          !(await isTerminatedArchiveProcess(this.connection, batch.ownerId)))
      )
        throw new Error('Archive deletion batch is already running');
      const executionToken = randomUUID();
      const claimed = await this.batches.updateOne(
        {
          _id: reviewId,
          guildId: this.guildId,
          state: batch.state,
          ...(batch.state === 'ready'
            ? { expiresAt: { $gt: Date.now() } }
            : { executionToken: batch.executionToken }),
        },
        { $set: { state: 'running', ownerId: ARCHIVE_PROCESS_ID, executionToken } },
      );
      if (claimed.matchedCount !== 1) throw new Error('Archive deletion batch is already running');
      let notifiedAt = Date.now();
      await onProgress?.(await this.progress(reviewId, actor)).catch(() => undefined);
      for (;;) {
        const page = await this.items
          .find({ reviewId, state: { $ne: 'complete' } })
          .sort({ sequence: 1 })
          .limit(25)
          .toArray();
        if (page.length === 0) break;
        for (const item of page) {
          const notification = await this.captureNotification(batch, item);
          await this.items.updateOne(
            { _id: item._id, state: { $ne: 'complete' } },
            {
              $set: {
                state: 'processing',
                ...(notification === undefined ? {} : { notification }),
              },
            },
          );
          let outcome: Outcome = 'protected';
          if (item.id !== undefined) {
            try {
              if (batch.kind === 'jobs')
                outcome = (await this.control.deleteJob(item.id)).pending ? 'pending' : 'deleted';
              else {
                await this.control.deletePlan(item.id);
                outcome = 'deleted';
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : '';
              outcome = protectedErrors.has(message)
                ? 'protected'
                : missingErrors.has(message)
                  ? 'deleted'
                  : 'failed';
            }
          }
          await this.items.updateOne(
            { _id: item._id, state: 'processing' },
            { $set: { state: 'complete', outcome } },
          );
          if (item.id !== undefined)
            await onItem?.({
              kind: batch.kind,
              id: item.id,
              outcome,
              ...(notification === undefined ? {} : { notification }),
            }).catch(() => undefined);
          if (Date.now() - notifiedAt >= 10_000) {
            notifiedAt = Date.now();
            await onProgress?.(await this.progress(reviewId, actor)).catch(() => undefined);
          }
        }
      }
      const result = { ...(await this.progress(reviewId, actor)), complete: true };
      if (result.remaining !== 0) throw new Error('Archive deletion snapshot is incomplete');
      await this.batches.updateOne(
        { _id: reviewId, executionToken },
        { $set: { state: 'complete', result } },
      );
      await onProgress?.(result).catch(() => undefined);
      return result;
    } finally {
      executions.delete(key);
    }
  }
}
