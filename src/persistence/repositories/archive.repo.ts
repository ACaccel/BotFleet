import {
  releaseArchiveRunConsumer,
  reserveArchiveRunConsumer,
  archiveJobDeletions,
  finalizeArchiveJobDeletion,
} from '../../infra/archive/lifecycle';
import { Types, mongo } from 'mongoose';
import { contentHash, mergeSnapshot } from '../../core/archive/normalize';
import { ARCHIVE_LIMITS } from '../../core/archive/limits';
import type { GuildConnection } from '../../infra/mongo/connection-manager';
import type {
  ArchiveSnapshot,
  ArchiveSourceDecision,
  ArchiveGatewayObservation,
  ArchiveInboxEntry,
  ArchiveJob,
  ArchiveJournal,
  ArchiveChannel,
} from '../../core/archive/types';

export type ArchiveMutationInterceptor = (
  collection: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason: string,
) => Promise<void>;
export type ArchiveSnapshotOutcome = 'inserted' | 'updated' | 'upgraded' | 'unchanged' | 'stale';
export interface ArchiveMutationContext {
  readonly interceptor?: ArchiveMutationInterceptor;
}
export interface ArchiveSnapshotContext extends ArchiveMutationContext {
  readonly observed?: Record<string, unknown> | null;
  readonly emptyReactions?: { readonly observedAt: number; readonly assertCurrent: () => void };
}
export interface ArchivePreparedMutation {
  readonly collection: string;
  readonly before: (Record<string, unknown> & { _id: unknown }) | null;
  readonly after: (Record<string, unknown> & { _id: unknown }) | null;
  readonly reason: string;
}
export interface ArchiveSnapshotBatchContext extends ArchiveMutationContext {
  readonly beforeWrite?: () => void;
  readonly batchInterceptor?: (
    mutations: readonly ArchivePreparedMutation[],
    beforeWrite?: () => void,
  ) => Promise<void>;
  readonly snapshotContexts?: readonly ArchiveSnapshotContext[];
}
export interface ArchiveRepo {
  persistSnapshot(
    snapshot: ArchiveSnapshot,
    context?: ArchiveSnapshotContext,
  ): Promise<ArchiveSnapshotOutcome>;
  loadSnapshotBatch(
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, Record<string, unknown>>>;
  persistSnapshotsBatch(
    snapshots: readonly ArchiveSnapshot[],
    context?: ArchiveSnapshotBatchContext,
  ): Promise<readonly ArchiveSnapshotOutcome[]>;
  recordSourceEvidence(
    messageId: string,
    snapshot: ArchiveSnapshot,
    decision?: ArchiveSourceDecision,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  tombstone(
    messageId: string,
    channelId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  enqueue(entry: Omit<ArchiveInboxEntry, 'state' | 'attempts'>): Promise<void>;
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
  releaseInbox(eventId: string, token: string): Promise<void>;
  deferInbox(eventId: string, token: string, reason: string, retryAt: number): Promise<void>;
  submitJob(job: ArchiveJob): Promise<ArchiveJob>;
  getJob(jobId: string): Promise<ArchiveJob | undefined>;
  claimJob(token: string, now: number, leaseMs: number): Promise<ArchiveJob | undefined>;
  updateJob(jobId: string, patch: Partial<ArchiveJob>, token?: string): Promise<void>;
  upsertChannel(channel: ArchiveChannel, context?: ArchiveMutationContext): Promise<void>;
  listChannels(): Promise<ArchiveChannel[]>;
  stageReaction(
    messageId: string,
    emojiKey: string,
    type: 0 | 1,
    generation: string,
    chunk: number,
    userIds: readonly string[],
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  publishReaction(
    messageId: string,
    emojiKey: string,
    type: 0 | 1,
    generation: string,
    expectedChunks: number,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  finalizeReactionRefresh(
    messageId: string,
    generation: string,
    streamKeys: readonly string[],
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  markReactionsStale(
    messageId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  collectReactionGarbage(
    messageId: string,
    keepGenerations: readonly string[],
    olderThan: number,
    context?: ArchiveMutationContext,
  ): Promise<number>;
  acquireOwner(ownerId: string, now: number): Promise<boolean>;
  releaseOwner(ownerId: string): Promise<void>;
  setMutationInterceptor(interceptor: ArchiveMutationInterceptor | undefined): void;
  appendJournal(journal: ArchiveJournal): Promise<void>;
  listJournal(runId: string, afterSequence?: number, limit?: number): Promise<ArchiveJournal[]>;
  markJournalApplied(journalId: string, state: ArchiveJournal['state']): Promise<void>;
}
export class MongoArchiveRepo implements ArchiveRepo {
  private interceptor: ArchiveMutationInterceptor | undefined;
  private inboxVersion = 0;
  private emptyInboxAt = Number.NEGATIVE_INFINITY;
  private emptyInboxUntil = Number.NEGATIVE_INFINITY;
  private pendingEmptyProbe: Promise<number | undefined> | undefined;
  constructor(
    private readonly conn: GuildConnection,
    owner: 'msg-archive',
  ) {
    if (owner !== 'msg-archive' || conn.archiveOwner !== 'msg-archive')
      throw new Error('Archive writes require msg-archive ownership');
  }
  public setMutationInterceptor(interceptor: ArchiveMutationInterceptor | undefined): void {
    this.interceptor = interceptor;
  }
  public async persistSnapshot(
    snapshot: ArchiveSnapshot,
    context?: ArchiveSnapshotContext,
  ): Promise<ArchiveSnapshotOutcome> {
    return this.writeSnapshot(snapshot, context);
  }
  /** Observations belong to one writer batch; full before-image predicates fence stale reads. */
  public async loadSnapshotBatch(
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, Record<string, unknown>>> {
    if (messageIds.length > ARCHIVE_LIMITS.batchDocuments)
      throw new RangeError('Archive snapshot batch exceeds document limit');
    const result = new Map<string, Record<string, unknown>>();
    if (messageIds.length === 0) return result;
    let bytes = 0;
    const cursor = this.conn.models.Message.collection
      .find({ messageId: { $in: [...new Set(messageIds)] } })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const document of cursor) {
        bytes += mongo.BSON.calculateObjectSize(document);
        if (bytes > ARCHIVE_LIMITS.batchBytes)
          throw new RangeError('Archive snapshot observations exceed byte limit');
        result.set(String(document.messageId), document);
      }
    } finally {
      await cursor.close();
    }
    return result;
  }
  public async persistSnapshotsBatch(
    snapshots: readonly ArchiveSnapshot[],
    context?: ArchiveSnapshotBatchContext,
  ): Promise<readonly ArchiveSnapshotOutcome[]> {
    const bytes = snapshots.reduce(
      (sum, snapshot) => sum + mongo.BSON.calculateObjectSize(snapshot),
      0,
    );
    if (
      snapshots.length > ARCHIVE_LIMITS.batchDocuments ||
      (bytes > ARCHIVE_LIMITS.batchBytes && !context?.snapshotContexts)
    )
      throw new RangeError('Archive snapshot batch exceeds admission limits');
    if (context?.snapshotContexts && context.snapshotContexts.length !== snapshots.length)
      throw new RangeError('Snapshot contexts must match snapshots');
    const observed = context?.snapshotContexts?.every((entry) => entry.observed !== undefined)
      ? new Map<string, Record<string, unknown>>()
      : await this.loadSnapshotBatch(snapshots.map((snapshot) => snapshot.messageId));
    const seen = new Set<string>();
    const outcomes: ArchiveSnapshotOutcome[] = [];
    let pending: ArchivePreparedMutation[] = [];
    let pendingBytes = 0;
    let fences: (() => void)[] = [];
    const guard = (): void => {
      context?.beforeWrite?.();
      for (const fence of fences) fence();
    };
    const flush = async (): Promise<void> => {
      guard();
      if (pending.length) {
        if (context?.batchInterceptor) await context.batchInterceptor(pending, guard);
        else if (context?.interceptor ?? this.interceptor) {
          for (const mutation of pending) {
            guard();
            await this.mutate(
              mutation.collection,
              mutation.before,
              mutation.after,
              mutation.reason,
              context,
            );
          }
        } else await this.applySnapshotMutations(pending, guard);
      }
      for (const fence of fences) fence();
      pending = [];
      pendingBytes = 0;
      fences = [];
    };
    for (const [index, snapshot] of snapshots.entries()) {
      const duplicate = seen.has(snapshot.messageId);
      if (duplicate) await flush();
      const itemContext = context?.snapshotContexts?.[index];
      const prepared: ArchivePreparedMutation[] = [];
      // Preparation is restricted to one snapshot. Its revision lookup precedes its only
      // message mutation; repeated identities must first observe the preceding commit.
      const outcome = await this.writeSnapshot(snapshot, {
        ...itemContext,
        ...(duplicate
          ? { observed: undefined }
          : {
              observed:
                itemContext?.observed !== undefined
                  ? itemContext.observed
                  : (observed.get(snapshot.messageId) ?? null),
            }),
        interceptor: async (collection, before, after, reason) => {
          prepared.push({
            collection,
            before: before as ArchivePreparedMutation['before'],
            after: after as ArchivePreparedMutation['after'],
            reason,
          });
        },
      });
      const preparedBytes = prepared.reduce(
        (sum, mutation) => sum + mongo.BSON.calculateObjectSize(mutation),
        0,
      );
      if (
        preparedBytes > ARCHIVE_LIMITS.batchBytes &&
        context?.batchInterceptor &&
        !(context.interceptor ?? this.interceptor)
      )
        throw new RangeError('Oversized archive mutation requires a single-mutation interceptor');
      if (
        pending.length + prepared.length > ARCHIVE_LIMITS.batchDocuments ||
        pendingBytes + preparedBytes > ARCHIVE_LIMITS.batchBytes
      )
        await flush();
      if (preparedBytes > ARCHIVE_LIMITS.batchBytes) {
        context?.beforeWrite?.();
        itemContext?.emptyReactions?.assertCurrent();
        for (const mutation of prepared) {
          context?.beforeWrite?.();
          itemContext?.emptyReactions?.assertCurrent();
          await this.mutate(
            mutation.collection,
            mutation.before,
            mutation.after,
            mutation.reason,
            context,
          );
        }
        itemContext?.emptyReactions?.assertCurrent();
      } else {
        pending.push(...prepared);
        pendingBytes += preparedBytes;
        if (itemContext?.emptyReactions) fences.push(itemContext.emptyReactions.assertCurrent);
      }
      outcomes.push(outcome);
      seen.add(snapshot.messageId);
    }
    await flush();
    return outcomes;
  }
  private async applySnapshotMutations(
    mutations: readonly ArchivePreparedMutation[],
    beforeWrite?: () => void,
  ): Promise<void> {
    // Snapshot preparation emits revision inserts before message writes. Complete and
    // verify the revision wave before publishing any corresponding message image.
    for (const collection of ['archive_revisions', 'messages']) {
      const wave = mutations.filter((mutation) => mutation.collection === collection);
      if (!wave.length) continue;
      const target = this.conn.connection.collection<Record<string, unknown>>(collection);
      const writes: mongo.AnyBulkWriteOperation<Record<string, unknown>>[] = wave.map(
        ({ before, after }) => {
          if (!after) throw new Error('Snapshot preparation cannot delete documents');
          return before
            ? {
                replaceOne: {
                  filter: {
                    _id: { $eq: before._id as mongo.ObjectId },
                    $expr: { $eq: ['$$ROOT', { $literal: before }] },
                  },
                  replacement: after,
                },
              }
            : {
                insertOne: { document: after as Record<string, unknown> & { _id: mongo.ObjectId } },
              };
        },
      );
      beforeWrite?.();
      const result = await target.bulkWrite(writes, {
        ordered: true,
        writeConcern: { w: 1, j: true },
      });
      if (result.matchedCount + result.insertedCount !== wave.length)
        throw new Error('Archive write conflict');
      const images = await target
        .find({ _id: { $in: wave.map(({ after }) => after!._id as mongo.ObjectId) } })
        .toArray();
      const identity = (_id: unknown): string =>
        Buffer.from(mongo.BSON.serialize({ _id })).toString('hex');
      const byId = new Map(images.map((document) => [identity(document._id), document]));
      for (const { after } of wave) {
        const actual = byId.get(identity(after!._id));
        if (
          !actual ||
          !Buffer.from(mongo.BSON.serialize(actual)).equals(
            Buffer.from(mongo.BSON.serialize(after!)),
          )
        )
          throw new Error('Archive batch verification failed');
      }
    }
  }

  public async recordSourceEvidence(
    messageId: string,
    snapshot: ArchiveSnapshot,
    decision?: ArchiveSourceDecision,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.Message.collection.findOne({ messageId });
    if (!before || (snapshot.authorKind === 'unknown' && decision === undefined)) return;
    const previousDecision = before.archiveSourceDecision as ArchiveSourceDecision | undefined;
    if (decision && previousDecision && previousDecision.observedAt > decision.observedAt) return;
    const after: Record<string, unknown> = {
      ...before,
      authorKind:
        snapshot.authorKind === 'unknown' ? (before.authorKind ?? 'unknown') : snapshot.authorKind,
      ...(decision === undefined ? {} : { archiveSourceDecision: decision }),
      sourceEvidenceAt: snapshot.observedAt,
    };
    for (const key of ['userId', 'webhookId', 'applicationId', 'policy'] as const)
      if (snapshot[key] !== undefined) after[key] = snapshot[key];
    await this.mutate('messages', before, after, 'source-classification-evidence', context);
  }
  public async tombstone(
    messageId: string,
    channelId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.Message.collection.findOne({ messageId });
    const after = before
      ? {
          ...before,
          deletion: {
            deletedAt: Math.min(
              Number(
                (before.deletion as { deletedAt?: number } | undefined)?.deletedAt ?? observedAt,
              ),
              observedAt,
            ),
            source: 'gateway',
          },
          observedAt: Math.max(Number(before.observedAt ?? 0), observedAt),
        }
      : {
          messageId,
          channelId,
          channelName: '',
          guildId: String(this.conn.guildId),
          schemaVersion: 2,
          authorKind: 'unknown',
          presence: {},
          deletion: { deletedAt: observedAt, source: 'gateway' },
          observedAt,
        };
    await this.mutate('messages', before, after, 'message-delete', context);
  }
  public async enqueue(entry: Omit<ArchiveInboxEntry, 'state' | 'attempts'>): Promise<void> {
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
          throw new RangeError('Archive inbox event exceeds memory budget');
        events.push(event as unknown as ArchiveInboxEntry);
        bytes += size;
        if (bytes >= ARCHIVE_LIMITS.batchBytes) break;
      }
    } finally {
      await cursor.close();
    }
    if (events.length === 0) {
      this.pendingEmptyProbe ??= this.conn.models.ArchiveInbox.collection
        .aggregate<{ nextAt: number }>([
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
        $inc: { attempts: 1 },
      },
    ).exec();
    return this.conn.models.ArchiveInbox.find({
      eventId: { $in: eventIds },
      claimToken: token,
      state: 'processing',
    })
      .sort({ observedAt: 1, eventId: 1 })
      .lean<ArchiveInboxEntry[]>()
      .exec();
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
      .lean<Array<Pick<ArchiveInboxEntry, 'claimToken' | 'state' | 'leaseUntil'>>>()
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
  public async releaseInbox(eventId: string, token: string): Promise<void> {
    this.invalidateInboxProbe();
    await this.conn.models.ArchiveInbox.updateOne(
      { eventId, claimToken: token },
      { $set: { state: 'pending' }, $unset: { claimToken: 1, leaseUntil: 1 } },
    ).exec();
    this.invalidateInboxProbe();
  }
  public async deferInbox(
    eventId: string,
    token: string,
    reason: string,
    retryAt: number,
  ): Promise<void> {
    this.invalidateInboxProbe();
    const result = await this.conn.models.ArchiveInbox.updateOne(
      { eventId, claimToken: token, state: 'processing' },
      {
        $set: { state: 'pending', nextAttemptAt: retryAt, lastError: reason.slice(0, 120) },
        $unset: { claimToken: 1, leaseUntil: 1 },
      },
    ).exec();
    if (!result.matchedCount) throw new Error('Inbox claim lost');
    this.invalidateInboxProbe();
  }
  public async submitJob(job: ArchiveJob): Promise<ArchiveJob> {
    if (
      await archiveJobDeletions(this.conn.connection).findOne({
        _id: 'job:' + job.jobId,
        guildId: job.guildId,
      })
    )
      throw new Error('Archive job was deleted');
    if (job.runId !== undefined)
      await reserveArchiveRunConsumer(this.conn.connection, job.guildId, job.runId, job.requestId);
    const existing = await this.conn.models.ArchiveJob.findOne({ requestId: job.requestId })
      .lean<ArchiveJob>()
      .exec();
    if (existing) {
      if (!['queued', 'running'].includes(existing.status))
        await releaseArchiveRunConsumer(this.conn.connection, existing.runId, existing.requestId);
      return existing;
    }
    await this.conn.connection
      .collection<ArchiveJob & { _id: string }>('archive_jobs')
      .updateOne(
        { _id: job.jobId },
        { $setOnInsert: { ...job, _id: job.jobId } },
        { upsert: true },
      );
    const stored = await this.conn.models.ArchiveJob.findOne({ requestId: job.requestId })
      .lean<ArchiveJob>()
      .exec();
    if (!stored) throw new Error('Job acknowledgement missing');
    const deletion = await archiveJobDeletions(this.conn.connection).findOne({
      _id: 'job:' + stored.jobId,
      guildId: stored.guildId,
    });
    if (deletion !== null) {
      await this.conn.models.ArchiveJob.updateOne(
        { jobId: stored.jobId },
        { $set: { cancelRequested: true, deleteRequestedAt: deletion.requestedAt } },
      ).exec();
      await finalizeArchiveJobDeletion(this.conn.connection, stored.guildId, stored.jobId);
      throw new Error('Archive job was deleted');
    }
    return stored;
  }
  public async getJob(jobId: string): Promise<ArchiveJob | undefined> {
    return (
      (await this.conn.models.ArchiveJob.findOne({ jobId }).lean<ArchiveJob>().exec()) ?? undefined
    );
  }
  public async claimJob(
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<ArchiveJob | undefined> {
    return (
      (await this.conn.models.ArchiveJob.findOneAndUpdate(
        { status: 'queued', cancelRequested: false, deleteRequestedAt: { $exists: false } },
        {
          $set: { status: 'running', claimToken: token, leaseUntil: now + leaseMs, startedAt: now },
        },
        { new: true, sort: { createdAt: 1 } },
      )
        .lean<ArchiveJob>()
        .exec()) ?? undefined
    );
  }
  public async updateJob(jobId: string, patch: Partial<ArchiveJob>, token?: string): Promise<void> {
    const result = await this.conn.models.ArchiveJob.updateOne(
      { jobId, ...(token ? { claimToken: token } : {}) },
      { $set: patch },
    ).exec();
    if (!result.matchedCount) throw new Error('Job claim lost');
    if (patch.status !== undefined && !['queued', 'running'].includes(patch.status)) {
      const job = await this.getJob(jobId);
      if (job !== undefined)
        await releaseArchiveRunConsumer(this.conn.connection, job.runId, job.requestId);
    }
  }
  public async upsertChannel(
    channel: ArchiveChannel,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.ArchiveChannel.collection.findOne({
      channelId: channel.channelId,
    });
    await this.mutate(
      'archive_channels',
      before,
      { ...before, ...channel },
      'channel-checkpoint',
      context,
    );
  }
  public async listChannels(): Promise<ArchiveChannel[]> {
    return this.conn.models.ArchiveChannel.find({}).lean<ArchiveChannel[]>().exec();
  }
  public async stageReaction(
    messageId: string,
    emojiKey: string,
    type: 0 | 1,
    generation: string,
    chunk: number,
    userIds: readonly string[],
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(chunk) ||
      chunk < 0 ||
      userIds.length > 1000 ||
      !userIds.every((id) => /^\d+$/.test(id))
    )
      throw new TypeError('Invalid reaction chunk');
    const identity = { messageId, emojiKey, type, generation, chunk };
    const before = await this.conn.models.ArchiveReaction.collection.findOne(identity);
    await this.mutate(
      'archive_reactions',
      before,
      { ...before, ...identity, userIds: [...new Set(userIds)], observedAt },
      'reaction-stage',
      context,
    );
  }
  public async publishReaction(
    messageId: string,
    emojiKey: string,
    type: 0 | 1,
    generation: string,
    expectedChunks: number,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const chunks = await this.conn.models.ArchiveReaction.find(
      { messageId, emojiKey, type, generation },
      { chunk: 1 },
    )
      .sort({ chunk: 1 })
      .lean<Array<{ chunk: number }>>()
      .exec();
    if (chunks.length !== expectedChunks || chunks.some((entry, index) => entry.chunk !== index))
      throw new Error('Incomplete reaction generation');
    const before = await this.conn.models.Message.collection.findOne({ messageId });
    if (!before || before.deletion) throw new Error('Reaction source missing or deleted');
    const generations = {
      ...(before.reactionGenerations as Record<string, unknown> | undefined),
      [`${emojiKey}:${type}`]: { generation, observedAt, complete: true },
    };
    await this.mutate(
      'messages',
      before,
      { ...before, reactionGenerations: generations },
      'reaction-publish',
      context,
    );
  }
  public async finalizeReactionRefresh(
    messageId: string,
    generation: string,
    streamKeys: readonly string[],
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.Message.collection.findOne({ messageId });
    if (!before || before.deletion) throw new Error('Reaction source missing or deleted');
    const existing = (before.reactionGenerations ?? {}) as Record<string, { generation: string }>;
    if (streamKeys.some((key) => existing[key]?.generation !== generation))
      throw new Error('Reaction stream not published');
    const after: Record<string, unknown> = {
      ...before,
      reactionGenerations: Object.fromEntries(streamKeys.map((key) => [key, existing[key]])),
      reactionsFreshAt: observedAt,
    };
    if (Number(before.reactionsStaleAt ?? 0) > observedAt)
      throw new Error('Reaction changed during refresh');
    delete after.reactionsStaleAt;
    await this.mutate('messages', before, after, 'reaction-refresh-complete', context);
  }
  public async markReactionsStale(
    messageId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.Message.collection.findOne({ messageId });
    if (!before) return;
    await this.mutate(
      'messages',
      before,
      { ...before, reactionsStaleAt: observedAt },
      'reaction-stale',
      context,
    );
  }
  public async collectReactionGarbage(
    messageId: string,
    keepGenerations: readonly string[],
    olderThan: number,
    context?: ArchiveMutationContext,
  ): Promise<number> {
    // Recovery before-images can reference old generations; conservative retention avoids breaking rollback.
    const protectedRuns = await this.conn.connection
      .collection('archive_repair_runs')
      .countDocuments({ status: { $nin: ['expired'] } }, { limit: 1 });
    const journals = await this.conn.models.ArchiveJournal.countDocuments({}).limit(1).exec();
    if (protectedRuns || journals || this.interceptor || context?.interceptor) return 0;
    const current = await this.conn.models.Message.collection.findOne({ messageId });
    const references = Object.values(
      (current?.reactionGenerations ?? {}) as Record<string, { generation: string }>,
    ).map((entry) => entry.generation);
    const cursor = this.conn.models.ArchiveReaction.collection.find({
      messageId,
      generation: { $nin: [...new Set([...keepGenerations, ...references])] },
      observedAt: { $lt: olderThan },
    });
    let removed = 0;
    for await (const before of cursor) {
      await this.mutate('archive_reactions', before, null, 'reaction-gc', context);
      removed += 1;
    }
    return removed;
  }
  public async acquireOwner(ownerId: string, now: number): Promise<boolean> {
    const collection = this.conn.connection.collection<{
      _id: string;
      key: string;
      ownerId: string;
      acquiredAt: number;
    }>('archive_leases');
    try {
      const existing = await collection.findOne({ _id: 'owner' });
      if (existing) return existing.ownerId === ownerId;
      await collection.insertOne({ _id: 'owner', key: 'owner', ownerId, acquiredAt: now });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
        return false;
      throw error;
    }
  }
  public async releaseOwner(ownerId: string): Promise<void> {
    await this.conn.connection
      .collection<{
        _id: string;
        key: string;
        ownerId: string;
        acquiredAt: number;
      }>('archive_leases')
      .deleteOne({ _id: 'owner', ownerId });
  }
  public async appendJournal(journal: ArchiveJournal): Promise<void> {
    await this.conn.models.ArchiveJournal.updateOne(
      { journalId: journal.journalId },
      { $setOnInsert: journal },
      { upsert: true },
    ).exec();
  }
  public async listJournal(
    runId: string,
    afterSequence = -1,
    limit = 100,
  ): Promise<ArchiveJournal[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError('Journal page limit must be 1..1000');
    return this.conn.models.ArchiveJournal.find({ runId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(limit)
      .lean<ArchiveJournal[]>()
      .exec();
  }
  public async markJournalApplied(
    journalId: string,
    state: ArchiveJournal['state'],
  ): Promise<void> {
    await this.conn.models.ArchiveJournal.updateOne({ journalId }, { $set: { state } }).exec();
  }
  private async mutate(
    collection: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    if (after && (before === null || !after._id)) {
      // MongoDB stores _id first; journal the same BSON order before hashing inserts.
      const { _id, ...fields } = after;
      after = { _id: _id || new Types.ObjectId(), ...fields };
    }
    if (after && mongo.BSON.calculateObjectSize(after) > 15 * 1024 * 1024)
      throw new Error('Archive document exceeds safe BSON limit');
    const interceptor = context?.interceptor ?? this.interceptor;
    if (interceptor) {
      await interceptor(collection, before, after, reason);
      return;
    }
    const target = this.conn.connection.collection<mongo.Document & { _id: mongo.ObjectId }>(
      collection,
    );
    if (before) {
      const result = after
        ? await target.replaceOne(
            {
              _id: before._id as mongo.ObjectId,
              $expr: { $eq: ['$$ROOT', { $literal: before }] },
            },
            after,
          )
        : await target.deleteOne({ _id: before._id as mongo.ObjectId });
      if (('matchedCount' in result ? result.matchedCount : result.deletedCount) !== 1)
        throw new Error('Archive write conflict');
    } else if (after) await target.insertOne(after as mongo.Document & { _id: mongo.ObjectId });
  }
  private async writeSnapshot(
    snapshot: ArchiveSnapshot,
    context?: ArchiveSnapshotContext,
  ): Promise<ArchiveSnapshotOutcome> {
    const before =
      context?.observed === undefined
        ? await this.conn.models.Message.collection.findOne({
            messageId: snapshot.messageId,
          })
        : context.observed;
    const merged = mergeSnapshot((before as Partial<ArchiveSnapshot>) ?? {}, snapshot);
    const gateway = this.gatewayTransition(before as Partial<ArchiveSnapshot> | null, snapshot);
    if (snapshot.observationId && before) {
      const replay =
        before.versionObservationId === snapshot.observationId ||
        (await this.conn.models.ArchiveRevision.exists({
          messageId: snapshot.messageId,
          versionObservationId: snapshot.observationId,
        }));
      if (replay) {
        // A crash may have committed the revision before updating the Gateway watermark.
        if (gateway.next)
          await this.mutate(
            'messages',
            before,
            { ...before, gatewayObservation: gateway.next },
            'gateway-observation-recovery',
            context,
          );
        return 'unchanged';
      }
    }
    const stale =
      before &&
      (snapshot.source === 'gateway'
        ? Number(before.observedAt ?? 0) > snapshot.observedAt ||
          (snapshot.editedTimestamp !== undefined &&
            snapshot.editedTimestamp !== null &&
            Number(before.editedTimestamp ?? 0) > snapshot.editedTimestamp)
        : Number(before.contentVersionAt ?? before.timestamp ?? 0) > snapshot.contentVersionAt ||
          (Number(before.contentVersionAt ?? before.timestamp ?? 0) === snapshot.contentVersionAt &&
            Number(before.observedAt ?? 0) > snapshot.observedAt));
    if (stale) {
      const matchesCurrent =
        (before.contentHash || contentHash(before as Partial<ArchiveSnapshot>)) ===
        merged.contentHash;
      if (!matchesCurrent || gateway.changed) await this.storeRevision(snapshot, context);
      if (matchesCurrent && gateway.changed)
        await this.storeRevision(before as unknown as ArchiveSnapshot, context);
      if (gateway.next)
        await this.mutate(
          'messages',
          before,
          {
            ...before,
            gatewayObservation: gateway.next,
            ...(matchesCurrent && gateway.changed
              ? { versionObservationId: snapshot.observationId }
              : {}),
          },
          'gateway-observation',
          context,
        );
      return 'stale';
    }
    const changed =
      before &&
      (before.contentHash || contentHash(before as Partial<ArchiveSnapshot>)) !==
        merged.contentHash;
    if (changed || gateway.changed)
      await this.storeRevision(before as unknown as ArchiveSnapshot, context);
    merged.versionObservationId =
      !before || changed || gateway.changed
        ? (snapshot.observationId ??
          `${snapshot.source}:${snapshot.contentVersionAt}:${merged.contentHash}`)
        : String(
            before.versionObservationId ??
              `${String(before.source ?? 'legacy')}:${String(before.contentVersionAt ?? before.timestamp ?? 0)}:${merged.contentHash}`,
          );
    const after: Record<string, unknown> = {
      ...before,
      ...merged,
      ...(gateway.next ? { gatewayObservation: gateway.next } : {}),
      firstObservedAt: before?.firstObservedAt ?? snapshot.observedAt,
    };
    delete after.archiveSourceDecision;
    if (context?.emptyReactions) {
      context.emptyReactions.assertCurrent();
      if (
        before?.deletion ||
        Number(before?.reactionsStaleAt ?? 0) > context.emptyReactions.observedAt
      )
        throw new Error('Reaction changed during refresh');
      after.reactionGenerations = {};
      after.reactionsFreshAt = context.emptyReactions.observedAt;
      delete after.reactionsStaleAt;
    }
    if (
      before &&
      Buffer.compare(
        Buffer.from(mongo.BSON.serialize(before)),
        Buffer.from(mongo.BSON.serialize(after)),
      ) === 0
    ) {
      if (context?.observed !== undefined) {
        const current = await this.conn.models.Message.collection.findOne(
          { _id: before._id as mongo.ObjectId, $expr: { $eq: ['$$ROOT', { $literal: before }] } },
          { projection: { _id: 1 } },
        );
        if (current === null) throw new Error('Archive write conflict');
      }
      return 'unchanged';
    }
    await this.mutate('messages', before, after, 'message-snapshot', context);
    return !before
      ? 'inserted'
      : before.schemaVersion !== 2
        ? 'upgraded'
        : changed
          ? 'updated'
          : 'unchanged';
  }
  private gatewayTransition(
    before: Partial<ArchiveSnapshot> | null,
    snapshot: ArchiveSnapshot,
  ): { next?: ArchiveGatewayObservation; changed: boolean } {
    if (snapshot.source !== 'gateway' || !snapshot.observationId) return { changed: false };
    const previous = before?.gatewayObservation;
    if (previous) {
      if (previous.observationId === snapshot.observationId) return { changed: false };
      const sequence = (id: string): RegExpMatchArray | null =>
        id.match(/^(.*):(\d{20}):MESSAGE_(?:CREATE|UPDATE)$/);
      const oldSequence = sequence(previous.observationId);
      const newSequence = sequence(snapshot.observationId);
      if (oldSequence && newSequence && oldSequence[1] === newSequence[1]) {
        if (BigInt(newSequence[2]!) <= BigInt(oldSequence[2]!)) return { changed: false };
      } else if (
        snapshot.observedAt < previous.observedAt ||
        (snapshot.observedAt === previous.observedAt &&
          snapshot.observationId < previous.observationId)
      )
        return { changed: false };
    }
    const fields = { ...previous?.fieldHashes };
    const observed: Record<string, string> = {};
    for (const key of [
      'content',
      'attachments',
      'stickers',
      'embeds',
      'mentions',
      'reference',
      'poll',
      'components',
      'snapshots',
      'type',
    ] as const) {
      if (snapshot.presence[key] !== 'present') continue;
      if (key === 'mentions') {
        for (const [field, value] of Object.entries(snapshot.mentions ?? {}))
          observed[`mentions.${field}`] = contentHash({ mentions: { [field]: value } });
      } else observed[key] = contentHash({ [key]: snapshot[key] });
    }
    const changed =
      previous !== undefined &&
      Object.entries(observed).some(
        ([field, hash]) =>
          previous.fieldHashes[field] !== undefined && previous.fieldHashes[field] !== hash,
      );
    Object.assign(fields, observed);
    return {
      changed,
      next: {
        observationId: snapshot.observationId,
        observedAt: snapshot.observedAt,
        fieldHashes: fields,
      },
    };
  }
  private async storeRevision(
    snapshot: ArchiveSnapshot,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const hash = snapshot.contentHash || contentHash(snapshot);
    const identity = {
      messageId: snapshot.messageId,
      contentVersionAt:
        snapshot.contentVersionAt ??
        snapshot.editedTimestamp ??
        snapshot.timestamp ??
        snapshot.observedAt ??
        0,
      contentHash: hash,
      versionObservationId:
        snapshot.versionObservationId ??
        snapshot.observationId ??
        `${snapshot.source ?? 'legacy'}:${snapshot.contentVersionAt ?? snapshot.timestamp ?? 0}:${hash}`,
    };
    const before = await this.conn.models.ArchiveRevision.collection.findOne(identity);
    if (!before) {
      const contentSnapshot = { ...snapshot } as Record<string, unknown>;
      for (const key of [
        '_id',
        'reactions',
        'reactionGenerations',
        'reactionsFreshAt',
        'reactionsStaleAt',
      ])
        delete contentSnapshot[key];
      await this.mutate(
        'archive_revisions',
        null,
        { ...identity, snapshot: contentSnapshot },
        'message-revision',
        context,
      );
    }
  }
}
