import { Types, mongo } from 'mongoose';
import { reactionKeyOf, reactionStreamKey } from '../../core/archive/normalize';
import { ARCHIVE_LIMITS } from '../../core/archive/limits';
import { ArchiveLimitExceededError } from '../../core/archive/errors';
import type { ArchiveMessage, ReactionStreamKey } from '../../core/archive/types';
import type { ArchiveOwner, GuildConnection } from '../connection';
import type { ArchiveReactionDoc } from '../schemas/archive.schema';
import {
  archiveMessages,
  assertArchiveWriter,
  writeArchiveDocument,
  type ArchiveMessageDocument,
  type ArchiveMutationContext,
  type StoredDocument,
} from './archive-mutation';

/** One staged membership chunk: up to 1000 user IDs of one reaction stream. */
export type ArchiveReactionChunk = Omit<ArchiveReactionDoc, 'userIds'> & {
  readonly userIds: readonly string[];
};
/** A stream a refresh staged completely: its key and how many chunks it has. */
export interface ArchiveReactionStream {
  readonly key: ReactionStreamKey;
  readonly chunks: number;
}
export interface ArchiveReactionRefreshContext extends ArchiveMutationContext {
  /**
   * A refresh of some reactions only. Listed streams replace their generations,
   * `removedKeys` (reactions no longer on the message) drop both of theirs, and the
   * others stay. `reactionsFreshAt` keeps its value; the stale mark is cleared only
   * when it is still `staleMark`, the mark of the change this refresh answers.
   */
  readonly partial?: { readonly removedKeys: readonly string[]; readonly staleMark: number };
}
/** Reaction membership: staged generations, their publication and garbage collection. */
export interface ArchiveReactionRepo {
  stageReactions(
    chunks: readonly ArchiveReactionChunk[],
    context?: ArchiveMutationContext,
  ): Promise<void>;
  finalizeReactionRefresh(
    messageId: string,
    generation: string,
    streams: readonly ArchiveReactionStream[],
    refreshedAt: number,
    context?: ArchiveReactionRefreshContext,
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
  /** Messages with reaction chunks older than `olderThan`, after the GC cursor. */
  reactionGarbageCandidates(olderThan: number, limit: number): Promise<string[]>;
  /** Saves the GC cursor; `undefined` starts the next sweep from the beginning. */
  saveReactionGarbageCursor(after: string | undefined): Promise<void>;
}
export class MongoArchiveReactionRepo implements ArchiveReactionRepo {
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
  }
  /**
   * Stages membership chunks of a refresh in one ordered insert. Chunks belong to a
   * new generation, so none exists yet; nothing references them until
   * `finalizeReactionRefresh` publishes the generation.
   */
  public async stageReactions(
    chunks: readonly ArchiveReactionChunk[],
    context?: ArchiveMutationContext,
  ): Promise<void> {
    if (chunks.length > ARCHIVE_LIMITS.batchDocuments)
      throw new ArchiveLimitExceededError('Archive reaction stage exceeds document limit');
    const documents = chunks.map((chunk) => {
      if (
        !Number.isSafeInteger(chunk.chunk) ||
        chunk.chunk < 0 ||
        chunk.userIds.length > 1000 ||
        !chunk.userIds.every((id) => /^\d+$/.test(id))
      )
        throw new TypeError('Invalid reaction chunk');
      return {
        _id: new Types.ObjectId(),
        messageId: chunk.messageId,
        emojiKey: chunk.emojiKey,
        type: chunk.type,
        generation: chunk.generation,
        chunk: chunk.chunk,
        channelId: chunk.channelId,
        userIds: [...new Set(chunk.userIds)],
        observedAt: chunk.observedAt,
      };
    });
    if (documents.length === 0) return;
    if (context?.interceptor) {
      for (const document of documents)
        await this.mutate('archive_reactions', null, document, 'reaction-stage', context);
      return;
    }
    const bytes = documents.reduce(
      (sum, document) => sum + mongo.BSON.calculateObjectSize(document),
      0,
    );
    if (bytes > ARCHIVE_LIMITS.batchBytes)
      throw new ArchiveLimitExceededError('Archive reaction stage exceeds byte limit');
    await this.conn.models.ArchiveReaction.collection.insertMany(documents, { ordered: true });
  }
  /**
   * Publishes a refresh in one write: every listed stream must have exactly its
   * staged chunks, and the message's generations, freshness and stale mark change
   * together. A full refresh replaces all generations and is fresh at
   * `refreshedAt`, when its membership reads began; a change marked after that
   * fails it. See {@link ArchiveReactionRefreshContext} for a partial one.
   */
  public async finalizeReactionRefresh(
    messageId: string,
    generation: string,
    streams: readonly ArchiveReactionStream[],
    refreshedAt: number,
    context?: ArchiveReactionRefreshContext,
  ): Promise<void> {
    const staged = new Map<string, number[]>();
    if (streams.some((stream) => stream.chunks > 0)) {
      const chunks = await this.conn.models.ArchiveReaction.find(
        { messageId, generation },
        { emojiKey: 1, type: 1, chunk: 1 },
      )
        .sort({ emojiKey: 1, type: 1, chunk: 1 })
        .lean<Array<Pick<ArchiveReactionDoc, 'emojiKey' | 'type' | 'chunk'>>>()
        .exec();
      for (const chunk of chunks) {
        const key = reactionStreamKey(chunk.emojiKey, chunk.type);
        staged.set(key, [...(staged.get(key) ?? []), chunk.chunk]);
      }
    }
    for (const stream of streams) {
      const chunks = staged.get(stream.key) ?? [];
      if (chunks.length !== stream.chunks || chunks.some((chunk, index) => chunk !== index))
        throw new Error('Incomplete reaction generation');
    }
    const before = await this.messages().findOne({ _id: messageId });
    if (!before || before.deletedAt !== undefined)
      throw new Error('Reaction source missing or deleted');
    const published: NonNullable<ArchiveMessage['reactionGenerations']> = {};
    for (const stream of streams)
      published[stream.key] = { generation, observedAt: refreshedAt, complete: true };
    const after: ArchiveMessage = { ...before };
    const partial = context?.partial;
    if (partial === undefined) {
      if ((before.reactionsStaleAt ?? 0) > refreshedAt)
        throw new Error('Reaction changed during refresh');
      after.reactionGenerations = published;
      after.reactionsFreshAt = refreshedAt;
      delete after.reactionsStaleAt;
    } else {
      const removed = new Set(partial.removedKeys);
      const kept: NonNullable<ArchiveMessage['reactionGenerations']> = {};
      for (const [key, entry] of Object.entries(before.reactionGenerations ?? {}) as [
        ReactionStreamKey,
        NonNullable<ArchiveMessage['reactionGenerations']>[ReactionStreamKey],
      ][])
        if (!removed.has(reactionKeyOf(key))) kept[key] = entry;
      after.reactionGenerations = { ...kept, ...published };
      if (before.reactionsStaleAt === partial.staleMark) delete after.reactionsStaleAt;
    }
    await this.mutate('messages', before, after, 'reaction-refresh-complete', context);
  }
  /** `reactionsStaleAt` only moves forward; an unchanged mark is not rewritten. */
  public async markReactionsStale(
    messageId: string,
    observedAt: number,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.messages().findOne({ _id: messageId });
    // An interaction record keeps no reactions, so there is nothing to refresh.
    if (!before || before.excludedFields?.includes('reactions') === true) return;
    if ((before.reactionsStaleAt ?? Number.NEGATIVE_INFINITY) >= observedAt) return;
    await this.mutate(
      'messages',
      before,
      { ...before, reactionsStaleAt: observedAt },
      'reaction-stale',
      context,
    );
  }
  /**
   * Deletes a message's membership chunks older than `olderThan` whose generation
   * neither its published `reactionGenerations` nor an in-flight refresh
   * (`keepGenerations`) uses. A missing message references nothing, so all of its
   * old chunks go.
   */
  public async collectReactionGarbage(
    messageId: string,
    keepGenerations: readonly string[],
    olderThan: number,
    context?: ArchiveMutationContext,
  ): Promise<number> {
    const current = await this.messages().findOne({ _id: messageId });
    const references = Object.values(current?.reactionGenerations ?? {}).flatMap((entry) =>
      entry === undefined ? [] : [entry.generation],
    );
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
  private gcCheckpoints() {
    return this.conn.connection.collection<{ _id: string; after?: string }>(
      'archive_gc_checkpoints',
    );
  }
  public async reactionGarbageCandidates(olderThan: number, limit: number): Promise<string[]> {
    const previous = await this.gcCheckpoints().findOne({ _id: 'reactions' });
    const candidates = await this.conn.models.ArchiveReaction.collection
      .aggregate<{
        _id: string;
      }>(
        [
          {
            $match: {
              observedAt: { $lt: olderThan },
              ...(previous?.after ? { messageId: { $gt: previous.after } } : {}),
            },
          },
          { $group: { _id: '$messageId' } },
          { $sort: { _id: 1 } },
          { $limit: limit },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    return candidates.map((candidate) => candidate._id);
  }
  public async saveReactionGarbageCursor(after: string | undefined): Promise<void> {
    await this.gcCheckpoints().updateOne(
      { _id: 'reactions' },
      after === undefined ? { $unset: { after: 1 } } : { $set: { after } },
      { upsert: true },
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
}
