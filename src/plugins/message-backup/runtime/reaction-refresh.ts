import { randomUUID } from 'node:crypto';
import { Routes } from 'discord.js';
import type { ArchiveSnapshot } from '../../../core/archive/types';
import { reactionStreamKey } from '../../../core/archive/normalize';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import type { ArchiveReactionChunk } from '../../../persistence/repositories/archive-reaction.repo';
import { KnownPhaseEstimator, type RemainingEstimate } from '../flow/progress';
import type { SourceObservations } from './observations';
import { ALL_REACTIONS, rawReactions, type ReactionRefreshOptions } from './reaction-scope';
import {
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** Rereads reaction membership lists and publishes them as new generations. */
export class ReactionRefresher {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'client' | 'config'>,
    private readonly observations: SourceObservations,
  ) {}

  public async refresh(
    state: ArchiveGuildState,
    raw: Record<string, unknown>,
    snapshot: ArchiveSnapshot,
    signal = state.signal.signal,
    onReactionProgress?: (estimate: RemainingEstimate | undefined) => Promise<void>,
    checkpoint?: () => Promise<void>,
    options: ReactionRefreshOptions = {},
  ): Promise<void> {
    const { fetchReactionMemberships, ArchiveReactionRefreshError } =
      await import('../flow/reactions');
    const scope = options.scope ?? ALL_REACTIONS;
    const generation = randomUUID();
    const active = state.reactions.generations.get(snapshot._id) ?? new Set<string>();
    active.add(generation);
    state.reactions.generations.set(snapshot._id, active);
    let ownPin: (() => void) | undefined;
    let refreshedRaw: Record<string, unknown> | undefined;
    try {
      const emptyObservation = this.observations.get(raw);
      if (
        scope.kind === 'all' &&
        emptyObservation?.valid === true &&
        (raw.reactions === undefined ||
          (Array.isArray(raw.reactions) && raw.reactions.length === 0)) &&
        this.observations.unchanged(
          state,
          snapshot._id,
          emptyObservation.since,
          emptyObservation.gapVersion,
        )
      ) {
        // Fresh empty evidence needs one atomic publication, including removal of old references.
        await checkpoint?.();
        await mutateArchive(state, async () => {
          if (signal.aborted) throw new Error('Archive reaction refresh cancelled');
          if (
            !this.observations.unchanged(
              state,
              snapshot._id,
              emptyObservation.since,
              emptyObservation.gapVersion,
            )
          )
            throw new Error('Reaction membership invalidated before publication');
          await state.repos.reactions.finalizeReactionRefresh(
            snapshot._id,
            generation,
            [],
            Date.now(),
          );
        });
        return;
      }
      if (options.staleMarked !== true)
        await mutateArchive(state, () =>
          state.repos.reactions.markReactionsStale(snapshot._id, Date.now()),
        );
      let observation = this.observations.get(raw);
      if (
        observation === undefined &&
        (raw.reactions === undefined ||
          (Array.isArray(raw.reactions) && raw.reactions.length === 0))
      ) {
        // The read window starts when the request runs, not while it waits in the queue.
        const refreshed = await this.ctx.scheduler.run(
          `reaction-evidence:${snapshot.channelId}:${snapshot._id}`,
          'enrichment',
          () =>
            this.observations.read(state, () =>
              this.ctx.options.client.rest.get(
                Routes.channelMessage(snapshot.channelId, snapshot._id),
                { signal },
              ),
            ),
          {
            signal,
            guildId: String(state.conn.guildId),
            resource: { route: 'message', channelId: snapshot.channelId },
          },
        );
        if (typeof refreshed === 'object' && refreshed !== null)
          refreshedRaw = refreshed as Record<string, unknown>;
        if (
          typeof refreshed !== 'object' ||
          refreshed === null ||
          !('id' in refreshed) ||
          ('reactions' in refreshed &&
            refreshed.reactions !== undefined &&
            !Array.isArray(refreshed.reactions))
        )
          throw new Error('Reaction source evidence unavailable');
        raw = refreshed as Record<string, unknown>;
        observation = this.observations.get(raw);
      }
      if (observation?.valid === false) throw new Error('Reaction source changed during fetch');
      // Evidence without a read window is judged from now on, pinned for this refresh.
      if (observation === undefined) ownPin = state.dirty.pin(snapshot._id);
      const since = observation?.since ?? state.dirty.current;
      const gapVersion = observation?.gapVersion ?? state.continuity.gapVersion;
      const current = (): boolean =>
        this.observations.unchanged(state, snapshot._id, since, gapVersion);
      // A reaction without an emoji ID or name has no identity and is not refreshed.
      const present = rawReactions(raw);
      const targeted = scope.kind === 'some' ? new Set(scope.keys) : undefined;
      const reactions =
        targeted === undefined ? present : present.filter((reaction) => targeted.has(reaction.key));
      // Reactions a partial refresh targets that the message no longer has.
      const removedKeys =
        targeted === undefined
          ? []
          : [...targeted].filter((key) => !present.some((reaction) => reaction.key === key));
      // A partial refresh of one type also reads the other when it has no complete list yet.
      const stored =
        scope.kind === 'some' && scope.type !== undefined
          ? await state.repos.messages.findMessage(snapshot._id)
          : undefined;
      const kindsOf = (key: string): ('normal' | 'burst')[] => {
        if (scope.kind !== 'some' || scope.type === undefined) return ['normal', 'burst'];
        const other = scope.type === 0 ? 1 : 0;
        return stored?.reactionGenerations?.[reactionStreamKey(key, other)]?.complete === true
          ? [scope.type === 0 ? 'normal' : 'burst']
          : ['normal', 'burst'];
      };
      const expected = reactions.every(
        (reaction) => typeof reaction.count === 'number' || reaction.count_details !== undefined,
      )
        ? reactions.reduce(
            (sum, reaction) =>
              sum +
              (reaction.count_details === undefined
                ? (reaction.count ?? 0)
                : reaction.count_details.normal + reaction.count_details.burst),
            0,
          )
        : undefined;
      const estimator = new KnownPhaseEstimator(
        'reactions',
        expected,
        Date.now,
        state.reactions.rates,
      );
      await onReactionProgress?.(estimator.snapshot());
      const streams = reactions.map((reaction) => ({
        emoji: reaction.emoji.id
          ? `${reaction.emoji.name ?? '_'}:${reaction.emoji.id}`
          : (reaction.emoji.name ?? ''),
        kinds: kindsOf(reaction.key),
        ...(observation?.valid === true && current()
          ? {
              emptyKinds: (['normal', 'burst'] as const).filter(
                (kind) => reaction.count_details?.[kind] === 0 || reaction.count === 0,
              ),
            }
          : {}),
      }));
      const canonicalKeys = new Map(
        reactions.map((reaction, index) => [streams[index]?.emoji, reaction.key]),
      );
      const keyOf = (emoji: string): string => {
        const key = canonicalKeys.get(emoji);
        if (key === undefined) throw new TypeError('Reaction stream without a reaction key');
        return key;
      };
      const chunks = new Map<string, number>();
      let reactionUsers = 0;
      let reactionPages = 0;
      const reportReactionActivity = (): void =>
        options.onActivity?.({ reactionUsers, reactionPages });
      if (streams.length > 0) reportReactionActivity();
      // Staged chunks are written together, bounded by the batch limits.
      let staged: ArchiveReactionChunk[] = [];
      let stagedBytes = 0;
      const flush = async (): Promise<void> => {
        if (staged.length === 0) return;
        const batch = staged;
        const bytes = stagedBytes;
        staged = [];
        stagedBytes = 0;
        await state.storage.withReservation(bytes * 2 + 4096, true, () =>
          mutateArchive(state, () => state.repos.reactions.stageReactions(batch)),
        );
      };
      // Every list reflects all changes before its first read; later ones are dirty.
      const refreshedAt = Date.now();
      const result = await fetchReactionMemberships({
        rest: this.ctx.options.client.rest,
        channelId: snapshot.channelId,
        messageId: snapshot._id,
        streams,
        // `@discordjs/rest` runs every reaction read of a channel on one handler, one
        // after another, so a second stream only overlaps staging with the next read;
        // more streams would add no parallel requests.
        concurrency: Math.min(2, this.ctx.options.config.concurrency),
        pipelineBudget: this.ctx.pipelineBudget,
        signal,
        isCurrent: current,
        evidenceScope: String(since),
        request: async (key, operation) => {
          await checkpoint?.();
          return this.ctx.scheduler.run(
            key,
            'enrichment',
            () => {
              reportReactionActivity();
              return operation();
            },
            {
              signal,
              guildId: String(state.conn.guildId),
              resource: { route: 'reactions', channelId: snapshot.channelId },
            },
          );
        },
        stage: async ({ emoji, kind, page, userIds }) => {
          await checkpoint?.();
          if (signal.aborted) throw new Error('Archive reaction refresh cancelled');
          const type = kind === 'normal' ? 0 : 1;
          staged.push({
            messageId: snapshot._id,
            channelId: snapshot.channelId,
            emojiKey: keyOf(emoji),
            type,
            generation,
            chunk: page,
            userIds,
            observedAt: Date.now(),
          });
          stagedBytes += userIds.length * 24 + 256;
          chunks.set(`${emoji}:${type}`, page + 1);
          reactionUsers += userIds.length;
          reactionPages += 1;
          if (
            staged.length >= ARCHIVE_LIMITS.batchDocuments ||
            stagedBytes >= ARCHIVE_LIMITS.batchBytes / 2
          )
            await flush();
          reportReactionActivity();
          estimator.commit(userIds.length);
          await onReactionProgress?.(estimator.snapshot());
        },
      });
      state.reactions.rates = estimator.speedSamples();
      if (signal.aborted) throw new Error('Archive reaction refresh cancelled');
      if (result.some((stream) => !stream.complete) || !current()) {
        throw new ArchiveReactionRefreshError(
          'Reaction membership changed or remains incomplete',
          result,
        );
      }
      await checkpoint?.();
      await flush();
      await mutateArchive(state, async () => {
        if (!current()) throw new Error('Reaction membership invalidated before publication');
        await state.repos.reactions.finalizeReactionRefresh(
          snapshot._id,
          generation,
          result.map((stream) => {
            const type = stream.kind === 'normal' ? 0 : 1;
            return {
              key: reactionStreamKey(keyOf(stream.emoji), type),
              chunks: chunks.get(`${stream.emoji}:${type}`) ?? 0,
            };
          }),
          refreshedAt,
          scope.kind === 'some'
            ? { partial: { removedKeys, staleMark: scope.staleMark } }
            : undefined,
        );
      });
    } finally {
      ownPin?.();
      if (refreshedRaw !== undefined) this.observations.release(refreshedRaw);
      try {
        await onReactionProgress?.(undefined);
      } finally {
        active.delete(generation);
        if (active.size === 0) state.reactions.generations.delete(snapshot._id);
      }
    }
  }

  public async sweepGarbage(state: ArchiveGuildState): Promise<void> {
    if ((state.reactions.nextGarbageAt ?? 0) > Date.now() || !state.ready) return;
    state.reactions.nextGarbageAt = Date.now() + 60_000;
    const olderThan = Date.now() - 86_400_000;
    const candidates = await state.repos.reactions.reactionGarbageCandidates(olderThan, 100);
    for (const messageId of candidates) {
      if (this.ctx.stopped) return;
      await mutateArchive(state, () =>
        state.repos.reactions.collectReactionGarbage(
          messageId,
          [...(state.reactions.generations.get(messageId) ?? [])],
          olderThan,
        ),
      );
      await state.repos.reactions.saveReactionGarbageCursor(messageId);
    }
    if (candidates.length === 0) await state.repos.reactions.saveReactionGarbageCursor(undefined);
  }
}
