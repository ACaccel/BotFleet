import { mongo } from 'mongoose';
import {
  fillSnapshot,
  isStaleObservation,
  mergeSnapshot,
  snowflakeTimestamp,
} from '../../core/archive/normalize';
import { ARCHIVE_LIMITS } from '../../core/archive/limits';
import { ArchiveLimitExceededError } from '../../core/archive/errors';
import type { ArchiveOwner, GuildConnection } from '../connection';
import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveSnapshot,
  type ArchiveMessage,
} from '../../core/archive/types';
import {
  archiveMessages,
  assertArchiveWriter,
  metadataUpdate,
  sameArchiveDocument,
  withoutMetadata,
  writeArchiveDocument,
  type ArchiveMessageDocument,
  type ArchiveMutationContext,
  type StoredDocument,
} from './archive-mutation';

export type { ArchiveMutationContext, ArchiveMutationInterceptor } from './archive-mutation';
/**
 * `unchanged` may still refresh `observedAt`; `stale` observations are not written;
 * `filled` stale observations only added fields the document lacked.
 */
export type ArchiveSnapshotOutcome = 'inserted' | 'updated' | 'unchanged' | 'filled' | 'stale';
export interface ArchiveSnapshotContext extends ArchiveMutationContext {
  /** The stored document the caller read (`null`: none); the write is fenced on it. */
  readonly observed?: ArchiveMessage | null;
  /**
   * The observation proves the message has no reactions as of `observedAt`; the same
   * write publishes empty lists. `assertCurrent` rejects evidence a later change
   * invalidated, checked again right before the write.
   */
  readonly emptyReactions?: { readonly observedAt: number; readonly assertCurrent?: () => void };
  /**
   * A membership refresh follows: the same write marks the reaction lists stale at
   * this time (`reactionsStaleAt` only moves forward), even when the observation
   * itself is too old to apply. Deleted messages and interaction records are not marked.
   */
  readonly staleReactions?: number;
}
interface ArchivePreparedMutation {
  readonly collection: string;
  readonly before: (Record<string, unknown> & { _id: unknown }) | null;
  readonly after: (Record<string, unknown> & { _id: unknown }) | null;
  readonly reason: string;
}
export interface ArchiveSnapshotBatchContext extends ArchiveMutationContext {
  readonly beforeWrite?: () => void;
  readonly snapshotContexts?: readonly ArchiveSnapshotContext[];
}
/** Archived messages: observation writes, tombstones and reads. */
export interface ArchiveRepo {
  persistSnapshot(
    snapshot: ArchiveSnapshot,
    context?: ArchiveSnapshotContext,
  ): Promise<ArchiveSnapshotOutcome>;
  loadSnapshotBatch(messageIds: readonly string[]): Promise<ReadonlyMap<string, ArchiveMessage>>;
  persistSnapshotsBatch(
    snapshots: readonly ArchiveSnapshot[],
    context?: ArchiveSnapshotBatchContext,
  ): Promise<readonly ArchiveSnapshotOutcome[]>;
  tombstone(
    messageId: string,
    channelId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void>;
  discardUnresolved(observed: ArchiveMessage, context?: ArchiveMutationContext): Promise<boolean>;
  findMessage(messageId: string): Promise<ArchiveMessage | null>;
  /** Distinct channel IDs `messages` holds. */
  messageChannelIds(): Promise<string[]>;
  /** Stored history per channel, the work a full scan of it repeats (see `StoredSourceWorkQuery`). */
  storedSourceWork(query: StoredSourceWorkQuery): Promise<StoredSourceWork[]>;
}
/** Which stored messages `storedSourceWork` counts, and how. */
export interface StoredSourceWorkQuery {
  /** Only messages created before this time count (a scan's cutoff). */
  readonly before: number;
  /**
   * Counts only these channels, each below its own bound (capped by `before`): the
   * messages resumed sources have yet to scan. Absent: every channel.
   */
  readonly sources?: ReadonlyMap<string, number>;
  /**
   * Also sum reaction lists, and skip deleted messages, which Discord no longer
   * returns. Costlier: message counts alone include deleted messages.
   */
  readonly reactions: boolean;
  readonly maxTimeMs: number;
  readonly signal?: AbortSignal;
}
/** One channel's stored history: messages, and reaction lists when they were summed. */
export interface StoredSourceWork {
  readonly channelId: string;
  readonly messages: number;
  readonly reactionLists?: number;
}
export class MongoArchiveRepo implements ArchiveRepo {
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
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
  ): Promise<ReadonlyMap<string, ArchiveMessage>> {
    if (messageIds.length > ARCHIVE_LIMITS.batchDocuments)
      throw new ArchiveLimitExceededError('Archive snapshot batch exceeds document limit');
    const result = new Map<string, ArchiveMessage>();
    if (messageIds.length === 0) return result;
    let bytes = 0;
    const cursor = this.messages()
      .find({ _id: { $in: [...new Set(messageIds)] } })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const document of cursor) {
        bytes += mongo.BSON.calculateObjectSize(document);
        if (bytes > ARCHIVE_LIMITS.batchBytes)
          throw new ArchiveLimitExceededError('Archive snapshot observations exceed byte limit');
        result.set(document._id, document);
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
      throw new ArchiveLimitExceededError('Archive snapshot batch exceeds admission limits');
    if (context?.snapshotContexts && context.snapshotContexts.length !== snapshots.length)
      throw new RangeError('Snapshot contexts must match snapshots');
    const observed = context?.snapshotContexts?.every((entry) => entry.observed !== undefined)
      ? new Map<string, ArchiveMessage>()
      : await this.loadSnapshotBatch(snapshots.map((snapshot) => snapshot._id));
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
        if (context?.interceptor) {
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
      const duplicate = seen.has(snapshot._id);
      if (duplicate) await flush();
      const itemContext = context?.snapshotContexts?.[index];
      const prepared: ArchivePreparedMutation[] = [];
      // Preparation is restricted to one snapshot and its single message mutation;
      // repeated identities must first observe the preceding commit.
      const outcome = await this.writeSnapshot(snapshot, {
        ...itemContext,
        ...(duplicate
          ? { observed: undefined }
          : {
              observed:
                itemContext?.observed !== undefined
                  ? itemContext.observed
                  : (observed.get(snapshot._id) ?? null),
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
        pending.length + prepared.length > ARCHIVE_LIMITS.batchDocuments ||
        pendingBytes + preparedBytes > ARCHIVE_LIMITS.batchBytes
      )
        await flush();
      if (preparedBytes > ARCHIVE_LIMITS.batchBytes) {
        context?.beforeWrite?.();
        itemContext?.emptyReactions?.assertCurrent?.();
        for (const mutation of prepared) {
          context?.beforeWrite?.();
          itemContext?.emptyReactions?.assertCurrent?.();
          await this.mutate(
            mutation.collection,
            mutation.before,
            mutation.after,
            mutation.reason,
            context,
          );
        }
        itemContext?.emptyReactions?.assertCurrent?.();
      } else {
        pending.push(...prepared);
        pendingBytes += preparedBytes;
        if (itemContext?.emptyReactions?.assertCurrent)
          fences.push(itemContext.emptyReactions.assertCurrent);
      }
      outcomes.push(outcome);
      seen.add(snapshot._id);
    }
    await flush();
    return outcomes;
  }
  private async applySnapshotMutations(
    mutations: readonly ArchivePreparedMutation[],
    beforeWrite?: () => void,
  ): Promise<void> {
    if (mutations.some((mutation) => mutation.collection !== 'messages'))
      throw new Error('Snapshot preparation writes only messages');
    const target = this.messages();
    const writes: mongo.AnyBulkWriteOperation<ArchiveMessageDocument>[] = mutations.map(
      ({ before, after }) => {
        if (!after) throw new Error('Snapshot preparation cannot delete documents');
        if (!before) return { insertOne: { document: after as unknown as ArchiveMessageDocument } };
        const filter = {
          _id: { $eq: String(before._id) },
          $expr: { $eq: ['$$ROOT', { $literal: before }] },
        };
        const update = metadataUpdate(before, after);
        return update === undefined
          ? { replaceOne: { filter, replacement: after as unknown as ArchiveMessageDocument } }
          : {
              updateOne: { filter, update: update as mongo.UpdateFilter<ArchiveMessageDocument> },
            };
      },
    );
    beforeWrite?.();
    // Ordered: a fenced write that conflicts stops the batch. The writes before it
    // stay applied; each is a complete, valid observation, and the caller retries
    // the page, which reads the new images.
    const result = await target.bulkWrite(writes, {
      ordered: true,
      writeConcern: { w: 1, j: true },
    });
    if (result.matchedCount + result.insertedCount !== mutations.length)
      throw new Error('Archive write conflict');
    const images = await target
      .find({ _id: { $in: mutations.map(({ after }) => String(after!._id)) } })
      .toArray();
    const byId = new Map(images.map((document) => [document._id, document]));
    for (const { after } of mutations) {
      const actual = byId.get(String(after!._id));
      if (
        !actual ||
        !Buffer.from(mongo.BSON.serialize(actual)).equals(Buffer.from(mongo.BSON.serialize(after!)))
      )
        throw new Error('Archive batch verification failed');
    }
  }

  /**
   * Marks a message deleted and keeps its content. A message never archived gets a
   * bare tombstone (identity and deletion time only): a create or REST observation
   * applied after the deletion then only fills it in and stays deleted.
   */
  public async tombstone(
    messageId: string,
    channelId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.messages().findOne({ _id: messageId });
    const after: ArchiveMessage = before
      ? {
          ...before,
          deletedAt: Math.min(before.deletedAt ?? observedAt, observedAt),
          observedAt: Math.max(before.observedAt ?? 0, observedAt),
        }
      : {
          _id: messageId,
          schemaVersion: ARCHIVE_SCHEMA_VERSION,
          channelId,
          createdTimestamp: snowflakeTimestamp(messageId),
          observedAt,
          deletedAt: observedAt,
        };
    await this.mutate('messages', before, after, 'message-delete', context);
  }
  /**
   * Removes a message kept only while its author was unknown, once a later
   * observation is rejected by the policy. Fenced on the observed document; any
   * other message is left alone. Returns whether it was removed.
   */
  public async discardUnresolved(
    observed: ArchiveMessage,
    context?: ArchiveMutationContext,
  ): Promise<boolean> {
    if (observed.policy?.reason !== 'unknown-author-retained') return false;
    await this.mutate('messages', observed, null, 'message-policy-rejected', context);
    return true;
  }
  public async findMessage(messageId: string): Promise<ArchiveMessage | null> {
    return this.conn.connection.collection<ArchiveMessage>('messages').findOne({ _id: messageId });
  }
  public async messageChannelIds(): Promise<string[]> {
    return (await this.conn.models.Message.distinct('channelId').exec()).filter(
      (id): id is string => typeof id === 'string',
    );
  }
  /**
   * One aggregation over `messages`. Without reactions it reads only the compound
   * index (a covered scan). With reactions, every channel is counted by a scan in
   * natural order, which reads less than fetching every document through an index;
   * named sources are read through the index within their bounds.
   */
  public async storedSourceWork(query: StoredSourceWorkQuery): Promise<StoredSourceWork[]> {
    const index = { channelId: 1, createdTimestamp: 1 };
    const live = query.reactions ? { deletedAt: { $exists: false } } : {};
    const sources = query.sources === undefined ? undefined : [...query.sources];
    if (sources?.length === 0) return [];
    // Every channel's cutoff is tested in the group rather than a `$match`: a range
    // on the index's second field alone makes the planner fetch every document.
    const pipeline =
      sources === undefined
        ? [
            ...(query.reactions ? [{ $match: live }] : []),
            sourceGroup(query.reactions, { $lt: ['$createdTimestamp', query.before] }),
          ]
        : [
            {
              $match: {
                $or: sources.map(([channelId, before]) => ({
                  channelId,
                  createdTimestamp: { $lt: Math.min(before, query.before) },
                })),
                ...live,
              },
            },
            sourceGroup(query.reactions),
          ];
    const rows = await this.messages()
      .aggregate<SourceTallyRow>([...pipeline, { $match: { messages: { $gt: 0 } } }], {
        maxTimeMS: query.maxTimeMs,
        hint: query.reactions && sources === undefined ? { $natural: 1 } : index,
        ...(query.signal === undefined ? {} : { signal: query.signal }),
      })
      .toArray();
    return rows.flatMap((row) =>
      typeof row._id === 'string'
        ? [
            {
              channelId: row._id,
              messages: row.messages,
              ...(row.reactionLists === undefined ? {} : { reactionLists: row.reactionLists }),
            },
          ]
        : [],
    );
  }
  private messages(): mongo.Collection<ArchiveMessageDocument> {
    return archiveMessages(this.conn);
  }
  private async mutate(
    collection: string,
    before: StoredDocument | null,
    after: StoredDocument | null,
    reason: string,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    await writeArchiveDocument(this.conn, collection, before, after, reason, context);
  }
  /**
   * Applies one observation to its message. A stale observation is dropped; a newer
   * one replaces the fields it carries, and an edit moves the previous content into
   * `editHistory` in the same replacement. The replacement is fenced by the full
   * before-image, so a concurrent change fails it instead of being overwritten.
   */
  private async writeSnapshot(
    snapshot: ArchiveSnapshot,
    context?: ArchiveSnapshotContext,
  ): Promise<ArchiveSnapshotOutcome> {
    const before: ArchiveMessage | null =
      context?.observed === undefined
        ? await this.messages().findOne({ _id: snapshot._id })
        : context.observed;
    if (before && isStaleObservation(before, snapshot)) {
      // An older observation never replaces stored content; it only fills gaps, such
      // as a create applied after its deletion's tombstone.
      const filled = fillSnapshot(before, snapshot);
      const marked = markStale(filled ?? before, context?.staleReactions);
      if (marked === undefined && filled === undefined) return 'stale';
      await this.mutate('messages', before, marked ?? filled!, 'message-fill', context);
      return filled === undefined ? 'stale' : 'filled';
    }
    const merged = mergeSnapshot(before ?? {}, snapshot);
    const after = markStale(merged, context?.staleReactions) ?? merged;
    if (context?.emptyReactions) {
      context.emptyReactions.assertCurrent?.();
      if (
        before?.deletedAt !== undefined ||
        (before?.reactionsStaleAt ?? 0) > context.emptyReactions.observedAt
      )
        throw new Error('Reaction changed during refresh');
      after.reactionGenerations = {};
      after.reactionsFreshAt = context.emptyReactions.observedAt;
      delete after.reactionsStaleAt;
    }
    if (before && sameArchiveDocument(before, after)) {
      if (context?.observed !== undefined) {
        const current = await this.messages().findOne(
          { _id: before._id, $expr: { $eq: ['$$ROOT', { $literal: before }] } },
          { projection: { _id: 1 } },
        );
        if (current === null) throw new Error('Archive write conflict');
      }
      return 'unchanged';
    }
    await this.mutate('messages', before, after, 'message-snapshot', context);
    if (!before) return 'inserted';
    // Outcomes count content: freshness and reaction metadata are not updates.
    return sameArchiveDocument(withoutMetadata(before), withoutMetadata(after))
      ? 'unchanged'
      : 'updated';
  }
}
/** A `storedSourceWork` group row, shaped by `sourceGroup`. */
interface SourceTallyRow {
  readonly _id: unknown;
  readonly messages: number;
  readonly reactionLists?: number;
}
/** Messages per channel (those `counted` selects), and reaction lists when asked. */
const sourceGroup = (reactions: boolean, counted?: mongo.Document): mongo.Document => {
  const selected = (value: unknown): unknown =>
    counted === undefined ? value : { $cond: [counted, value, 0] };
  return {
    $group: {
      _id: '$channelId',
      messages: { $sum: selected(1) },
      ...(reactions
        ? {
            reactionLists: {
              $sum: selected({ $cond: [{ $isArray: '$reactions' }, { $size: '$reactions' }, 0] }),
            },
          }
        : {}),
    },
  };
};
/**
 * `message` with its reaction lists marked stale at `at`, or `undefined` when there
 * is nothing to mark: no refresh follows, the mark is already as late, or the
 * message is deleted or keeps no reactions.
 */
const markStale = (message: ArchiveMessage, at: number | undefined): ArchiveMessage | undefined =>
  at === undefined ||
  message.deletedAt !== undefined ||
  message.excludedFields?.includes('reactions') === true ||
  (message.reactionsStaleAt ?? Number.NEGATIVE_INFINITY) >= at
    ? undefined
    : { ...message, reactionsStaleAt: at };
