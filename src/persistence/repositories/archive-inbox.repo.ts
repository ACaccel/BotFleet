import { mongo } from 'mongoose';
import { ARCHIVE_LIMITS } from '../../core/archive/limits';
import type {
  ArchiveInboxDelivery,
  ArchiveInboxDocument,
  ArchiveInboxDraft,
  ArchiveInboxEntry,
} from '../../core/archive/types';
import type { ArchiveOwner, GuildConnection } from '../connection';
import {
  ArchiveInboxInvalidError,
  ArchiveInboxOversizedError,
  parseInboxEntry,
  type RawInboxDocument,
} from './archive-inbox.parse';
import { assertArchiveWriter } from './archive-mutation';

export {
  ArchiveInboxInvalidError,
  ArchiveInboxOversizedError,
  isArchiveInboxUnclaimable,
} from './archive-inbox.parse';

/** The durable Gateway inbox: admission, claims, outcomes and dead letters. */
export interface ArchiveInboxRepo {
  enqueue(entry: ArchiveInboxDraft): Promise<void>;
  claimInbox(token: string, now: number, leaseMs: number): Promise<ArchiveInboxEntry | undefined>;
  claimInboxBatch(
    token: string,
    now: number,
    leaseMs: number,
    limit?: number,
  ): Promise<readonly ArchiveInboxEntry[]>;
  renewInboxBatch(
    token: string,
    eventIds: readonly string[],
    now: number,
    leaseMs: number,
  ): Promise<void>;
  ackInbox(eventId: string, token: string): Promise<void>;
  releaseInbox(eventId: string, token: string, resetClaims?: boolean): Promise<void>;
  deferInbox(
    eventId: string,
    token: string,
    reason: string,
    retryAt: number,
    counters?: ArchiveInboxCounters,
  ): Promise<void>;
  deadLetterInbox(
    eventId: string,
    fence: ArchiveInboxFence,
    reason: string,
    now: number,
    counters?: ArchiveInboxCounters,
  ): Promise<void>;
  /** Returns claimed events to pending after the previous owner was proven gone. */
  releaseProcessingInbox(): Promise<void>;
  /** Approximate stored bytes of the inbox, for admission. */
  inboxBytes(): Promise<number>;
  /** Whether a later open event of the same message exists. */
  hasNewerOpenEvent(entry: ArchiveInboxEntry): Promise<boolean>;
  /** An older open snapshot event of the reaction's message, if any. */
  olderOpenSnapshot(
    entry: Extract<ArchiveInboxEntry, { kind: 'reaction' }>,
  ): Promise<Pick<ArchiveInboxEntry, 'nextAttemptAt'> | null>;
  /** Open events observed by `cutoff`, later ones, and the oldest later one's time. */
  inboxBacklog(cutoff: number): Promise<ArchiveInboxBacklog>;
  /** Open events and the observation time of the oldest. */
  openInbox(): Promise<{ readonly pending: number; readonly oldestObservedAt?: number }>;
  untracedDeadLetters(limit: number): Promise<Pick<ArchiveInboxEntry, 'eventId' | 'channelId'>[]>;
  /** Marks dead letters as reported by the periodic run `runId`. */
  traceDeadLetters(eventIds: readonly string[], runId: string): Promise<void>;
  /** Dead letters the periodic run `runId` reports. */
  tracedDeadLetters(runId: string): Promise<Pick<ArchiveInboxEntry, 'channelId'>[]>;
}
/** Open inbox events split at a pass's cutoff. */
export interface ArchiveInboxBacklog {
  readonly pending: number;
  readonly live: number;
  readonly oldestLiveAt?: number;
}
/** A claimed event is fenced by its claim token; an unclaimable one must still be open. */
export type ArchiveInboxFence =
  | { readonly kind: 'claim'; readonly token: string }
  | { readonly kind: 'unclaimable' };
/** Failure bookkeeping stored with a deferred or dead event. */
export interface ArchiveInboxCounters {
  readonly attempts?: number;
  readonly firstFailedAt?: number;
}
const counterFields = (counters: ArchiveInboxCounters | undefined) => ({
  ...(counters?.attempts === undefined ? {} : { attempts: counters.attempts }),
  ...(counters?.firstFailedAt === undefined ? {} : { firstFailedAt: counters.firstFailedAt }),
});
export class MongoArchiveInboxRepo implements ArchiveInboxRepo {
  private inboxVersion = 0;
  private emptyInboxAt = Number.NEGATIVE_INFINITY;
  private emptyInboxUntil = Number.NEGATIVE_INFINITY;
  private pendingEmptyProbe: Promise<number | undefined> | undefined;
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
  }
  public async enqueue(entry: ArchiveInboxDraft): Promise<void> {
    this.invalidateInboxProbe();
    await this.conn.models.ArchiveInbox.updateOne(
      { eventId: entry.eventId },
      { $setOnInsert: { ...entry, state: 'pending', attempts: 0 } },
      { upsert: true },
    ).exec();
    this.invalidateInboxProbe();
  }
  public async claimInbox(
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<ArchiveInboxEntry | undefined> {
    return (await this.claimInboxBatch(token, now, leaseMs, 1))[0];
  }
  /** Claims retain each event's lease and order; a losing consumer cannot acknowledge another token. */
  public async claimInboxBatch(
    token: string,
    now: number,
    leaseMs: number,
    limit = 100,
  ): Promise<readonly ArchiveInboxEntry[]> {
    if (
      !token ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ARCHIVE_LIMITS.batchDocuments
    )
      throw new TypeError('Invalid archive inbox batch claim');
    if (now >= this.emptyInboxAt && now < this.emptyInboxUntil) return [];
    const version = this.inboxVersion;
    const eligible = {
      $and: [
        { $or: [{ state: 'pending' }, { state: 'processing', leaseUntil: { $lte: now } }] },
        { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
      ],
    };
    const events: ArchiveInboxEntry[] = [];
    let bytes = 0;
    const cursor = this.conn.models.ArchiveInbox.collection
      .find(eligible)
      .sort({ observedAt: 1, eventId: 1 })
      .limit(limit)
      .batchSize(Math.min(limit, 10));
    try {
      for await (const event of cursor) {
        const size = mongo.BSON.calculateObjectSize(event);
        if (events.length > 0 && bytes + size > ARCHIVE_LIMITS.batchBytes) break;
        if (size > ARCHIVE_LIMITS.pipelineBytes)
          throw new ArchiveInboxOversizedError(String(event['eventId']));
        let entry: ArchiveInboxEntry;
        try {
          entry = parseInboxEntry(event as unknown as RawInboxDocument);
        } catch (error) {
          // Claim the valid events ahead of it first; the invalid one is reported as the head.
          if (events.length > 0 && error instanceof ArchiveInboxInvalidError) break;
          throw error;
        }
        events.push(entry);
        bytes += size;
        if (bytes >= ARCHIVE_LIMITS.batchBytes) break;
      }
    } finally {
      await cursor.close();
    }
    if (events.length === 0) {
      this.pendingEmptyProbe ??= this.conn.models.ArchiveInbox.collection
        .aggregate<{ nextAt: number }>([
          { $match: { state: { $in: ['pending', 'processing'] } } },
          {
            $project: {
              availableAt: {
                $max: [
                  { $cond: [{ $eq: ['$state', 'processing'] }, '$leaseUntil', 0] },
                  { $ifNull: ['$nextAttemptAt', 0] },
                ],
              },
            },
          },
          { $group: { _id: null, nextAt: { $min: '$availableAt' } } },
        ])
        .next()
        .then((next) => next?.nextAt)
        .finally(() => {
          this.pendingEmptyProbe = undefined;
        });
      const nextAt = await this.pendingEmptyProbe;
      if (version === this.inboxVersion) {
        this.emptyInboxAt = now;
        this.emptyInboxUntil = Math.min(now + 250, nextAt ?? now + 250);
      }
      return [];
    }
    const eventIds = events.map((event) => event.eventId);
    await this.conn.models.ArchiveInbox.updateMany(
      { ...eligible, eventId: { $in: eventIds } },
      {
        $set: { state: 'processing', claimToken: token, leaseUntil: now + leaseMs },
        $inc: { claims: 1 },
      },
    ).exec();
    const claimed = await this.conn.models.ArchiveInbox.find({
      eventId: { $in: eventIds },
      claimToken: token,
      state: 'processing',
    })
      .sort({ observedAt: 1, eventId: 1 })
      .lean<ArchiveInboxDocument[]>()
      .exec();
    return claimed.map(parseInboxEntry);
  }
  public async renewInboxBatch(
    token: string,
    eventIds: readonly string[],
    now: number,
    leaseMs: number,
  ): Promise<void> {
    if (
      !token ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      eventIds.length > ARCHIVE_LIMITS.batchDocuments
    )
      throw new TypeError('Invalid archive inbox lease renewal');
    const ids = [...new Set(eventIds)];
    if (ids.length === 0) return;
    const result = await this.conn.models.ArchiveInbox.updateMany(
      { eventId: { $in: ids }, claimToken: token, state: 'processing', leaseUntil: { $gt: now } },
      { $set: { leaseUntil: now + leaseMs } },
    ).exec();
    if (result.matchedCount === ids.length) return;
    const remaining = await this.conn.models.ArchiveInbox.find(
      { eventId: { $in: ids } },
      { claimToken: 1, state: 1, leaseUntil: 1 },
    )
      .lean<Array<Pick<ArchiveInboxDelivery, 'claimToken' | 'state' | 'leaseUntil'>>>()
      .exec();
    // A completed acknowledgement may race the heartbeat; an existing foreign claim may not.
    if (
      remaining.some(
        (entry) =>
          entry.claimToken !== token ||
          entry.state !== 'processing' ||
          (entry.leaseUntil ?? 0) <= now,
      )
    )
      throw new Error('Inbox claim lost');
  }
  private invalidateInboxProbe(): void {
    this.inboxVersion += 1;
    this.emptyInboxUntil = Number.NEGATIVE_INFINITY;
  }
  public async ackInbox(eventId: string, token: string): Promise<void> {
    const result = await this.conn.models.ArchiveInbox.deleteOne({
      eventId,
      claimToken: token,
      state: 'processing',
    }).exec();
    if (!result.deletedCount) throw new Error('Inbox claim lost');
  }
  /**
   * Returns a claimed event to the queue without an outcome. `resetClaims: false`
   * keeps its claim streak, for an event whose reduction crashed.
   */
  public async releaseInbox(eventId: string, token: string, resetClaims = true): Promise<void> {
    this.invalidateInboxProbe();
    await this.conn.models.ArchiveInbox.updateOne(
      { eventId, claimToken: token },
      {
        $set: { state: 'pending', ...(resetClaims ? { claims: 0 } : {}) },
        $unset: { claimToken: 1, leaseUntil: 1 },
      },
    ).exec();
    this.invalidateInboxProbe();
  }
  /**
   * Returns a claimed event to the queue with a recorded outcome; given counters
   * replace the stored ones, and the claim streak resets.
   */
  public async deferInbox(
    eventId: string,
    token: string,
    reason: string,
    retryAt: number,
    counters?: ArchiveInboxCounters,
  ): Promise<void> {
    this.invalidateInboxProbe();
    const result = await this.conn.models.ArchiveInbox.updateOne(
      { eventId, claimToken: token, state: 'processing' },
      {
        $set: {
          state: 'pending',
          nextAttemptAt: retryAt,
          lastError: reason.slice(0, 120),
          claims: 0,
          ...counterFields(counters),
        },
        $unset: { claimToken: 1, leaseUntil: 1 },
      },
    ).exec();
    if (!result.matchedCount) throw new Error('Inbox claim lost');
    this.invalidateInboxProbe();
  }
  /** Retires an event that can never be reconciled; it stays for inspection until its TTL. */
  public async deadLetterInbox(
    eventId: string,
    fence: ArchiveInboxFence,
    reason: string,
    now: number,
    counters?: ArchiveInboxCounters,
  ): Promise<void> {
    this.invalidateInboxProbe();
    const result = await this.conn.models.ArchiveInbox.updateOne(
      fence.kind === 'claim'
        ? { eventId, claimToken: fence.token, state: 'processing' }
        : { eventId, state: { $in: ['pending', 'processing'] } },
      {
        $set: {
          state: 'dead',
          deadAt: new Date(now),
          lastError: reason.slice(0, 120),
          ...counterFields(counters),
        },
        $unset: { claimToken: 1, leaseUntil: 1, nextAttemptAt: 1 },
      },
    ).exec();
    if (!result.matchedCount) throw new Error('Inbox claim lost');
    this.invalidateInboxProbe();
  }
  public async releaseProcessingInbox(): Promise<void> {
    await this.conn.models.ArchiveInbox.updateMany(
      { state: 'processing' },
      { $set: { state: 'pending' }, $unset: { claimToken: 1, leaseUntil: 1 } },
    ).exec();
  }
  public async inboxBytes(): Promise<number> {
    const stats = await this.conn.models.ArchiveInbox.collection
      .aggregate<{
        bytes: number;
      }>([{ $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }])
      .next();
    return stats?.bytes ?? 0;
  }
  public async hasNewerOpenEvent(entry: ArchiveInboxEntry): Promise<boolean> {
    const newer = await this.conn.models.ArchiveInbox.exists({
      messageId: entry.messageId,
      state: { $in: ['pending', 'processing'] },
      $or: [
        { observedAt: { $gt: entry.observedAt } },
        { observedAt: entry.observedAt, eventId: { $gt: entry.eventId } },
      ],
    }).exec();
    return newer !== null;
  }
  public async olderOpenSnapshot(
    entry: Extract<ArchiveInboxEntry, { kind: 'reaction' }>,
  ): Promise<Pick<ArchiveInboxEntry, 'nextAttemptAt'> | null> {
    return this.conn.models.ArchiveInbox.findOne(
      {
        messageId: entry.messageId,
        kind: 'snapshot',
        state: { $in: ['pending', 'processing'] },
        $or: [
          { observedAt: { $lt: entry.observedAt } },
          { observedAt: entry.observedAt, eventId: { $lt: entry.eventId } },
        ],
      },
      { nextAttemptAt: 1 },
    )
      .lean<Pick<ArchiveInboxEntry, 'nextAttemptAt'>>()
      .exec();
  }
  public async inboxBacklog(cutoff: number): Promise<ArchiveInboxBacklog> {
    const inbox = this.conn.models.ArchiveInbox;
    const open = { state: { $in: ['pending', 'processing'] } };
    const pending = await inbox
      .countDocuments({ ...open, observedAt: { $lte: cutoff } })
      .maxTimeMS(5000)
      .exec();
    const later = { ...open, observedAt: { $gt: cutoff } };
    const live = await inbox.countDocuments(later).maxTimeMS(5000).exec();
    const oldest =
      live === 0
        ? null
        : await inbox.collection.findOne(later, {
            sort: { observedAt: 1 },
            projection: { observedAt: 1 },
            maxTimeMS: 5000,
          });
    return { pending, live, ...(oldest === null ? {} : { oldestLiveAt: oldest.observedAt }) };
  }
  public async openInbox(): Promise<{
    readonly pending: number;
    readonly oldestObservedAt?: number;
  }> {
    const collection = this.conn.models.ArchiveInbox.collection;
    const pending = await collection.countDocuments(
      { state: { $in: ['pending', 'processing'] } },
      { maxTimeMS: 5000 },
    );
    const oldest = await collection.findOne(
      { state: { $in: ['pending', 'processing'] } },
      { sort: { observedAt: 1 }, projection: { observedAt: 1 }, maxTimeMS: 5000 },
    );
    return { pending, ...(oldest === null ? {} : { oldestObservedAt: oldest.observedAt }) };
  }
  public async untracedDeadLetters(
    limit: number,
  ): Promise<Pick<ArchiveInboxEntry, 'eventId' | 'channelId'>[]> {
    return this.conn.models.ArchiveInbox.find(
      { state: 'dead', tracedRunId: { $exists: false } },
      { eventId: 1, channelId: 1 },
    )
      .limit(limit)
      .lean<Pick<ArchiveInboxEntry, 'eventId' | 'channelId'>[]>()
      .exec();
  }
  public async traceDeadLetters(eventIds: readonly string[], runId: string): Promise<void> {
    await this.conn.models.ArchiveInbox.updateMany(
      { eventId: { $in: eventIds }, state: 'dead' },
      { $set: { tracedRunId: runId } },
    ).exec();
  }
  public async tracedDeadLetters(runId: string): Promise<Pick<ArchiveInboxEntry, 'channelId'>[]> {
    return this.conn.models.ArchiveInbox.find(
      { state: 'dead', tracedRunId: runId },
      { channelId: 1 },
    )
      .maxTimeMS(5000)
      .lean<Pick<ArchiveInboxEntry, 'channelId'>[]>()
      .exec();
  }
}
