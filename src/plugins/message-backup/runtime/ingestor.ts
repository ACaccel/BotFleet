import type { GuildBasedChannel } from 'discord.js';
import type { ArchiveMessage, ArchiveSnapshot } from '../../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import {
  mergeSnapshot,
  normalizeMessage,
  reactionStreamKey,
} from '../../../core/archive/normalize';
import {
  applyPolicyDecision,
  evaluatePolicy,
  type ArchivePolicyLocation,
} from '../../../core/archive/policy';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import {
  ArchiveBackpressureError,
  ArchiveCapacityError,
  ArchiveLimitExceededError,
} from '../../../core/archive/errors';
import type { ArchiveSnapshotContext } from '../../../persistence/repositories/archive.repo';
import { archiveDocumentBytes } from '../../../persistence/repositories/archive-mutation';
import type { RemainingEstimate } from '../flow/progress';
import { isAutomatedSource, type ChannelLocator } from './channel-location';
import { classifyArchiveInboxFailure } from './inbox-failure';
import { ArchiveJobStoppedError } from './job-cancellation';
import type { SourceObservations } from './observations';
import type { ReactionRefresher } from './reaction-refresh';
import {
  ALL_REACTIONS,
  noReactions,
  rawReactions,
  sameReactionCounts,
  type ReactionRefreshOptions,
  type ReactionRefreshScope,
} from './reaction-scope';
import {
  ArchiveScanInterruptedError,
  isProgrammerError,
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** How `saveSnapshot` stores an observation. */
interface SaveSnapshotOptions {
  /** Background (history) work, which storage pressure pauses first. */
  readonly bulk: boolean;
  /**
   * Decides, from the stored document, whether the same write marks the reaction
   * lists stale for a refresh that follows, and at what time.
   */
  readonly staleFor?: (previous: ArchiveMessage | null) => number | undefined;
  /** The message is stored from its creation; its empty reaction list is complete as of then. */
  readonly createdAt?: number;
}
/** How `ingest` stores a REST observation and refreshes its lists. */
export interface IngestOptions {
  readonly channel?: GuildBasedChannel;
  readonly signal?: AbortSignal;
  readonly onReactionProgress?: (estimate: RemainingEstimate | undefined) => Promise<void>;
  /** A live reconciliation's lists to reread (see `liveRefreshScope`); all by default. */
  readonly scope?: ReactionRefreshScope;
  /** Reports membership progress of a history source; live ingests leave it unset. */
  readonly onReactionActivity?: ReactionRefreshOptions['onActivity'];
}
/** One stored history page. */
export interface HistoryPageResult {
  admitted: boolean[];
  counts: Pick<
    ArchiveProgressSnapshot['messages'],
    'inserted' | 'updated' | 'unchanged' | 'durable'
  >;
  reactions: number;
  /** Messages whose membership refresh failed and stayed marked stale. */
  staleReactions: number;
}

/** Stores REST observations, live and history pages alike, and refreshes their reaction lists. */
export class HistoryIngestor {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'logger' | 'policy'>,
    private readonly observations: SourceObservations,
    private readonly locator: ChannelLocator,
    private readonly reactions: ReactionRefresher,
  ) {}

  /**
   * Stores an observation the policy admits. `message`: the whole message was
   * stored; `interaction-record`: only its interaction record; `deleted`: stored on
   * a deleted message, whose reactions are no longer refreshed. `previous` is the
   * document before the write.
   */
  public async saveSnapshot(
    state: ArchiveGuildState,
    snapshot: ArchiveSnapshot,
    location: ArchivePolicyLocation,
    { bulk, staleFor, createdAt }: SaveSnapshotOptions,
  ): Promise<{
    outcome: 'rejected' | 'deleted' | 'message' | 'interaction-record';
    previous: ArchiveMessage | null;
  }> {
    return mutateArchive(state, async () => {
      const previous = await this.findMessage(state, snapshot._id);
      const decision = evaluatePolicy(
        mergeSnapshot(previous ?? {}, snapshot),
        this.ctx.options.policy,
        location,
      );
      if (!decision.admitted) {
        // A message kept only until its author was known goes once it is rejected.
        if (previous !== null) await state.repos.messages.discardUnresolved(previous);
        return { outcome: 'rejected', previous };
      }
      const stored = applyPolicyDecision(snapshot, decision);
      const staleReactions = staleFor?.(previous);
      // A newly created message's empty reaction list is complete as of its creation.
      const created =
        createdAt !== undefined && previous === null && decision.reason !== 'interaction-record';
      await state.storage.withReservation(
        Buffer.byteLength(JSON.stringify(stored)) * 4 + 4096,
        bulk,
        () =>
          state.repos.messages.persistSnapshot(stored, {
            observed: previous,
            ...(staleReactions === undefined ? {} : { staleReactions }),
            ...(created ? { emptyReactions: { observedAt: createdAt } } : {}),
          }),
      );
      if (previous?.deletedAt !== undefined) return { outcome: 'deleted', previous };
      return {
        outcome: decision.reason === 'interaction-record' ? 'interaction-record' : 'message',
        previous,
      };
    });
  }

  public findMessage(state: ArchiveGuildState, messageId: string): Promise<ArchiveMessage | null> {
    return state.repos.messages.findMessage(messageId);
  }

  /**
   * Stores one REST observation and refreshes its reaction lists. `refresh` narrows
   * a live reconciliation (see `liveRefreshScope`); a partial or counts-only scope
   * widens to all lists when the counts of other reactions changed.
   */
  public async ingest(
    state: ArchiveGuildState,
    raw: Record<string, unknown>,
    {
      channel,
      signal = state.signal.signal,
      onReactionProgress,
      onReactionActivity,
      ...options
    }: IngestOptions = {},
  ): Promise<boolean> {
    try {
      const snapshot = normalizeMessage(raw, {
        observedAt: Date.now(),
        ...(channel === undefined ? {} : { channelId: channel.id }),
      });
      const location =
        channel === undefined
          ? await this.locator.channelLocation(
              state,
              snapshot.channelId,
              undefined,
              isAutomatedSource(snapshot),
            )
          : this.locator.locationOf(state, channel);
      const observation = this.observations.get(raw);
      // Fresh empty evidence is published with one write, without a stale mark.
      const emptyProof =
        observation?.valid === true &&
        noReactions(raw) &&
        this.observations.unchanged(state, snapshot._id, observation.since, observation.gapVersion);
      let scope = options.scope ?? ALL_REACTIONS;
      let staleMarked = false;
      const { outcome } = await this.saveSnapshot(state, snapshot, location, {
        bulk: true,
        staleFor: (previous) => {
          if (
            scope.kind !== 'all' &&
            (previous === null ||
              !sameReactionCounts(raw, previous, new Set(scope.kind === 'some' ? scope.keys : [])))
          )
            scope = ALL_REACTIONS;
          if (scope.kind === 'none' || (scope.kind === 'all' && emptyProof)) return undefined;
          staleMarked = true;
          // A partial refresh keeps the mark of the change it answers.
          return scope.kind === 'some' ? scope.staleMark : snapshot.observedAt;
        },
      });
      if (outcome !== 'message') return outcome === 'interaction-record';
      if (scope.kind === 'none') return true;
      await this.reactions.refresh(state, raw, snapshot, signal, onReactionProgress, undefined, {
        staleMarked,
        scope,
        ...(onReactionActivity === undefined ? {} : { onActivity: onReactionActivity }),
      });
      return true;
    } finally {
      this.observations.release(raw);
    }
  }

  /**
   * Stores one history page and refreshes its reaction lists. `reuseReactions`
   * lets a periodic pass keep lists that Gateway capture proves current (see
   * `reactionsCurrent`).
   */
  public async ingestPage(
    state: ArchiveGuildState,
    raws: readonly Record<string, unknown>[],
    channel: GuildBasedChannel,
    signal: AbortSignal,
    checkpoint: () => Promise<void>,
    reuseReactions = false,
  ): Promise<{
    admitted: boolean[];
    counts: Pick<
      ArchiveProgressSnapshot['messages'],
      'inserted' | 'updated' | 'unchanged' | 'durable'
    >;
    reactions: number;
    /** Messages whose membership refresh failed and stayed marked stale. */
    staleReactions: number;
  }> {
    try {
      return await this.ingestPageObserved(
        state,
        raws,
        channel,
        signal,
        checkpoint,
        reuseReactions,
      );
    } finally {
      for (const raw of raws) this.observations.release(raw);
    }
  }

  private async ingestPageObserved(
    state: ArchiveGuildState,
    raws: readonly Record<string, unknown>[],
    channel: GuildBasedChannel,
    signal: AbortSignal,
    checkpoint: () => Promise<void>,
    reuseReactions: boolean,
  ): Promise<HistoryPageResult> {
    const normalizeStarted = performance.now();
    const snapshots = raws.map((raw) =>
      normalizeMessage(raw, { channelId: channel.id, observedAt: Date.now() }),
    );
    const location = this.locator.locationOf(state, channel);
    this.ctx.pipelineBudget.record('normalize', performance.now() - normalizeStarted);
    const counts = { inserted: 0, updated: 0, unchanged: 0, durable: 0 };
    const writeStarted = performance.now();
    const admitted: boolean[] = [];
    const emptyFinalized = new Set<number>();
    const staleMarked = new Set<number>();
    const reused = new Set<number>();
    for (let offset = 0; offset < snapshots.length; ) {
      await checkpoint();
      // One writer turn takes the rest of the page within the batch limits; a repeated
      // identity must observe the preceding durable commit.
      const batch: ArchiveSnapshot[] = [];
      const identities = new Set<string>();
      let batchBytes = 0;
      for (const snapshot of snapshots.slice(offset)) {
        if (identities.has(snapshot._id) || batch.length >= ARCHIVE_LIMITS.batchDocuments) break;
        const bytes = archiveDocumentBytes(snapshot);
        if (batch.length > 0 && batchBytes + bytes > ARCHIVE_LIMITS.batchBytes) break;
        identities.add(snapshot._id);
        batch.push(snapshot);
        batchBytes += bytes;
      }
      state.progress?.activity(channel.id, {
        step: 'writing',
        pageProcessed: admitted.length,
        pageTotal: raws.length,
        provisional: true,
      });
      await mutateArchive(state, async () => {
        let previous: ReadonlyMap<string, ArchiveMessage> | undefined;
        for (;;) {
          try {
            previous = await state.repos.messages.loadSnapshotBatch(batch.map((item) => item._id));
            break;
          } catch (error) {
            if (!(error instanceof ArchiveLimitExceededError)) throw error;
            // Large stored documents shrink the turn; a single one is read on its own.
            if (batch.length === 1) break;
            batch.splice(Math.ceil(batch.length / 2));
          }
        }
        const pending: ArchiveSnapshot[] = [];
        const contexts: ArchiveSnapshotContext[] = [];
        const positions: number[] = [];
        let reservationBytes = 0;
        for (const [batchIndex, snapshot] of batch.entries()) {
          if (signal.aborted) throw new Error('Archive page cancelled before write');
          const observed =
            previous === undefined
              ? await this.findMessage(state, snapshot._id)
              : (previous.get(snapshot._id) ?? null);
          const decision = evaluatePolicy(
            mergeSnapshot(observed ?? {}, snapshot),
            this.ctx.options.policy,
            location,
          );
          if (!decision.admitted) {
            if (observed !== null)
              await state.storage.withReservation(4096, true, () =>
                state.repos.messages.discardUnresolved(observed),
              );
            admitted.push(false);
            continue;
          }
          const index = offset + batchIndex;
          const stored = applyPolicyDecision(snapshot, decision);
          snapshots[index] = stored;
          const raw = raws[index]!;
          const observation = this.observations.get(raw);
          // An interaction record keeps no reactions, so it never publishes membership.
          const proof =
            decision.reason !== 'interaction-record' &&
            observed?.deletedAt === undefined &&
            observation?.valid === true &&
            (raw.reactions === undefined ||
              (Array.isArray(raw.reactions) && raw.reactions.length === 0)) &&
            this.observations.unchanged(
              state,
              snapshot._id,
              observation.since,
              observation.gapVersion,
            )
              ? observation
              : undefined;
          // A nonempty refresh follows unless the published lists are proven current;
          // the snapshot write marks its lists stale.
          const refreshes =
            proof === undefined &&
            decision.reason !== 'interaction-record' &&
            observed?.deletedAt === undefined;
          if (
            refreshes &&
            reuseReactions &&
            observation !== undefined &&
            this.reactionsCurrent(state, raw, observed, observation)
          )
            reused.add(index);
          else if (refreshes) staleMarked.add(index);
          contexts.push({
            observed,
            ...(staleMarked.has(index) ? { staleReactions: snapshot.observedAt } : {}),
            ...(proof !== undefined
              ? {
                  emptyReactions: {
                    observedAt: snapshot.observedAt,
                    assertCurrent: () => {
                      if (signal.aborted) throw new Error('Archive page cancelled before write');
                      if (
                        !this.observations.unchanged(
                          state,
                          snapshot._id,
                          proof.since,
                          proof.gapVersion,
                        )
                      )
                        throw new Error('Reaction membership invalidated before publication');
                    },
                  },
                }
              : {}),
          });
          pending.push(stored);
          positions.push(index);
          reservationBytes +=
            (archiveDocumentBytes(stored) +
              (observed === null ? 0 : archiveDocumentBytes(observed))) *
              4 +
            4096;
          admitted.push(observed?.deletedAt === undefined);
          state.progress?.activity(channel.id, {
            step: 'writing',
            pageProcessed: admitted.length,
            pageTotal: raws.length,
            provisional: true,
          });
        }
        if (pending.length > 0) {
          const outcomes = await state.storage.withReservation(reservationBytes, true, () =>
            state.repos.messages.persistSnapshotsBatch(pending, {
              snapshotContexts: contexts,
              beforeWrite: () => {
                if (signal.aborted) throw new Error('Archive page cancelled before write');
              },
            }),
          );
          for (const [index, outcome] of outcomes.entries()) {
            const position = positions[index]!;
            if (!admitted[position]) continue;
            counts.durable += 1;
            if (outcome === 'stale') counts.unchanged += 1;
            else if (outcome === 'filled') counts.updated += 1;
            else counts[outcome] += 1;
            // A stale or filled observation never publishes its empty reaction evidence.
            if (
              contexts[index]?.emptyReactions !== undefined &&
              outcome !== 'stale' &&
              outcome !== 'filled'
            )
              emptyFinalized.add(position);
          }
        }
      });
      offset += batch.length;
    }
    this.ctx.pipelineBudget.record('write', performance.now() - writeStarted);
    let reactions = 0;
    let staleReactions = 0;
    for (let index = 0; index < raws.length; index += 1) {
      if (!admitted[index] || emptyFinalized.has(index)) continue;
      if (reused.has(index)) {
        // The published lists stay; they count as completed without being reread.
        reactions += 1;
        continue;
      }
      await checkpoint();
      if (signal.aborted) throw new Error('Archive page cancelled before reactions');
      const raw = raws[index]!;
      const snapshot = snapshots[index]!;
      if (snapshot.excludedFields?.includes('reactions') === true) continue;
      const required = Array.isArray(raw.reactions) && raw.reactions.length > 0;
      if (required)
        state.progress?.activity(channel.id, {
          step: 'reactions',
          pageProcessed: index,
          pageTotal: raws.length,
          provisional: true,
        });
      const started = performance.now();
      const refreshed = await this.enrichPageReactions(
        state,
        raw,
        snapshot,
        signal,
        checkpoint,
        staleMarked.has(index),
      );
      this.ctx.pipelineBudget.record('reactions', performance.now() - started);
      if (!refreshed) staleReactions += 1;
      else if (required) reactions += 1;
      state.progress?.activity(channel.id, {
        step: 'processing',
        pageProcessed: index + 1,
        pageTotal: raws.length,
        provisional: true,
      });
    }
    return { admitted, counts, reactions, staleReactions };
  }

  /**
   * Whether a periodic pass may keep a message's published reaction lists instead of
   * rereading them. Gateway capture has been lossless since `continuousSince`
   * and every later reaction change reaches the inbox, so lists completely
   * refreshed after it stay current while the message has no unsettled live
   * change. The page must still report the same reactions and counts, read without
   * a change since, and every stream must be published and not marked stale.
   * Full scans and sources whose live events may be missing never reuse lists.
   */
  private reactionsCurrent(
    state: ArchiveGuildState,
    raw: Record<string, unknown>,
    stored: ArchiveMessage | null,
    observation: { readonly since: number; readonly gapVersion: number; readonly valid: boolean },
  ): boolean {
    if (
      stored === null ||
      stored.deletedAt !== undefined ||
      stored.reactionsStaleAt !== undefined ||
      stored.reactionsFreshAt === undefined ||
      stored.reactionsFreshAt < state.continuity.continuousSince ||
      state.dirty.versionOf(stored._id) !== undefined ||
      !observation.valid ||
      !this.observations.unchanged(state, stored._id, observation.since, observation.gapVersion)
    )
      return false;
    const reactions = rawReactions(raw);
    if (
      reactions.length === 0 ||
      reactions.some((reaction) => reaction.count_details === undefined) ||
      !sameReactionCounts(raw, stored)
    )
      return false;
    const streams = new Set<string>(
      reactions.flatMap((reaction) => [
        reactionStreamKey(reaction.key, 0),
        reactionStreamKey(reaction.key, 1),
      ]),
    );
    const published = Object.entries(stored.reactionGenerations ?? {});
    return (
      published.length === streams.size &&
      published.every(([key, entry]) => streams.has(key) && entry?.complete === true)
    );
  }

  /**
   * One message's membership refresh during a history page. A failure confined
   * to that message (a list that kept changing, an incomplete or unavailable list, an
   * unknown message) leaves it marked stale, keeping its previous complete list, and
   * the page still checkpoints. Failures that would hit every message the same way
   * fail the page so it is retried: interruption, capacity pressure, transient
   * transport or database faults (5xx, 429, timeouts, dropped connections), a lost
   * channel or permission, programmer errors, or a failure to record the stale mark.
   */
  private async enrichPageReactions(
    state: ArchiveGuildState,
    raw: Record<string, unknown>,
    snapshot: ArchiveSnapshot,
    signal: AbortSignal,
    checkpoint: () => Promise<void>,
    staleMarked: boolean,
  ): Promise<boolean> {
    try {
      await this.reactions.refresh(state, raw, snapshot, signal, undefined, checkpoint, {
        staleMarked,
        onActivity: (counts) =>
          state.progress?.activity(snapshot.channelId, {
            step: 'reactions',
            ...counts,
            provisional: true,
          }),
      });
      return true;
    } catch (error) {
      if (
        signal.aborted ||
        this.ctx.stopped ||
        error instanceof ArchiveScanInterruptedError ||
        error instanceof ArchiveJobStoppedError ||
        error instanceof ArchiveCapacityError ||
        // A full admission queue would refuse the next message as well.
        error instanceof ArchiveBackpressureError ||
        isProgrammerError(error) ||
        classifyArchiveInboxFailure(error).kind !== 'retry'
      )
        throw error;
      if (!staleMarked)
        await mutateArchive(state, () =>
          state.repos.reactions.markReactionsStale(snapshot._id, Date.now()),
        );
      this.ctx.options.logger.warn(
        { guildId: String(state.conn.guildId), channelId: snapshot.channelId, err: error },
        'Archive reaction refresh left stale; page continues',
      );
      return false;
    }
  }
}
