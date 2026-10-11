import { randomUUID } from 'node:crypto';
import { Routes } from 'discord.js';
import type { ArchiveInboxEntry, ArchiveMessage } from '../../../core/archive/types';
import {
  isArchiveInboxUnclaimable,
  type ArchiveInboxCounters,
} from '../../../persistence/repositories/archive-inbox.repo';
import { isAutomatedSource, type ChannelLocator } from './channel-location';
import type { GatewayContinuity } from './continuity';
import {
  ARCHIVE_INBOX_MAX_CLAIMS,
  classifyArchiveInboxFailure,
  decideArchiveInboxFailure,
} from './inbox-failure';
import { ArchiveInboxLoop } from './inbox-loop';
import type { HistoryIngestor } from './ingestor';
import type { SourceObservations } from './observations';
import { liveRefreshScope } from './reaction-scope';
import {
  isProgrammerError,
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** A live event's REST reconciliation failed after its own payload was persisted. */
class ArchiveLiveReconcileError extends Error {
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ArchiveLiveReconcileError';
  }
}
/** An event overtaking an open older event of its message waits at least this long. */
const EVENT_WAIT_MS = 5000;
/** Inbox events one round of the inbox loop retires before checking for more. */
const INBOX_ROUND = 100;
/**
 * A live event cannot be reduced yet: it overtook an older open event of the same
 * message. It is deferred, uncounted, until `retryAt`.
 */
class ArchiveEventWaitingError extends Error {
  public constructor(public readonly retryAt: number) {
    super('Archive event waits for an older event of its message');
    this.name = 'ArchiveEventWaitingError';
  }
}

/** What inbox reduction needs from the worker's other collaborators. */
export interface InboxReducerDependencies {
  readonly continuity: Pick<GatewayContinuity, 'flagGap'>;
  readonly locator: Pick<ChannelLocator, 'channelLocation' | 'registerChannel'>;
  readonly ingestor: Pick<HistoryIngestor, 'findMessage' | 'ingest' | 'saveSnapshot'>;
  readonly observations: Pick<SourceObservations, 'read'>;
}

/**
 * Reduces the durable Gateway inbox: claims events in order, applies each to the
 * archive and settles failures as deferrals, coverage gaps or dead letters.
 */
export class ArchiveInboxReducer {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'client' | 'config' | 'inboxLoop' | 'logger'>,
    private readonly deps: InboxReducerDependencies,
  ) {}

  /**
   * Reduces up to `limit` inbox events; a caller during a round shares it. Returns
   * how many events the round retired.
   */
  public async drainInbox(guildId: string, limit = 100): Promise<number> {
    const state = await this.ctx.initialize(guildId);
    if (!state.ready) return 0;
    if (state.inbox.draining !== undefined) return state.inbox.draining;
    state.inbox.draining = this.reduceInbox(state, guildId, limit).finally(() => {
      state.inbox.draining = undefined;
    });
    return state.inbox.draining;
  }

  /** A new pass may log a deferred drain once again. */
  public beginPass(state: ArchiveGuildState): void {
    state.inbox.drainWarned = false;
  }

  /**
   * History scans must not fail a source because live reconciliation is unavailable.
   * Programmer errors and shutdown still propagate; the warning is logged once per pass.
   */
  public async drainInboxSafely(state: ArchiveGuildState): Promise<void> {
    const guildId = String(state.conn.guildId);
    try {
      await this.drainInbox(guildId);
    } catch (error) {
      if (
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError ||
        this.ctx.stopped ||
        state.signal.signal.aborted
      )
        throw error;
      if (state.inbox.drainWarned === true) return;
      state.inbox.drainWarned = true;
      this.ctx.options.logger.warn(
        { guildId, err: error },
        'Archive inbox drain deferred during history scan',
      );
    }
  }

  private async reduceInbox(
    state: ArchiveGuildState,
    guildId: string,
    limit: number,
  ): Promise<number> {
    let processed = 0;
    while (processed < limit && !this.ctx.stopped && state.ready) {
      const claimToken = randomUUID();
      let entries: readonly ArchiveInboxEntry[];
      try {
        entries = await state.repos.inbox.claimInboxBatch(
          claimToken,
          Date.now(),
          60000,
          Math.min(16, limit - processed),
        );
      } catch (error) {
        // An oversized head event can never be claimed; retire it so later events proceed.
        if (!isArchiveInboxUnclaimable(error)) throw error;
        await state.repos.inbox.deadLetterInbox(
          error.eventId,
          { kind: 'unclaimable' },
          error.message,
          Date.now(),
        );
        this.retireCapture(state, error.eventId);
        this.ctx.options.logger.error(
          { guildId, eventId: error.eventId, err: error },
          'Archive inbox event dead-lettered',
        );
        processed += 1;
        continue;
      }
      if (entries.length === 0) break;
      const outstanding = new Set(entries.map((entry) => entry.eventId));
      const latest = new Map<string, string>();
      for (const entry of entries)
        if (entry.messageId !== undefined) {
          if (entry.kind === 'delete') latest.delete(entry.messageId);
          else if (entry.kind === 'snapshot' || entry.kind === 'reaction')
            latest.set(entry.messageId, entry.eventId);
        }
      let renewing: Promise<void> | undefined;
      let leaseFailure: unknown;
      const timer = setInterval(() => {
        if (renewing !== undefined) return;
        renewing = state.repos.inbox
          .renewInboxBatch(claimToken, [...outstanding], Date.now(), 60000)
          .catch((error: unknown) => {
            leaseFailure = error;
          })
          .finally(() => {
            renewing = undefined;
          });
      }, 20000);
      timer.unref();
      // An event whose reduction threw a programmer error keeps its claim streak, so
      // repeating it ends in a dead letter instead of stalling the inbox.
      let crashed: string | undefined;
      try {
        for (const entry of entries) {
          if (this.ctx.stopped || !state.ready) break;
          if (leaseFailure !== undefined) throw leaseFailure;
          if ((entry.claims ?? 0) > ARCHIVE_INBOX_MAX_CLAIMS) {
            // Repeated claims without an outcome mean applying it crashes or outlives its lease.
            await this.deadLetter(state, guildId, entry, claimToken, 'Archive inbox claim limit', {
              attempts: entry.attempts,
            });
            outstanding.delete(entry.eventId);
            processed += 1;
            continue;
          }
          let failure: { readonly error: unknown } | undefined;
          try {
            await this.applyEvent(
              state,
              entry,
              entry.messageId === undefined || latest.get(entry.messageId) === entry.eventId,
            );
          } catch (error) {
            if (isProgrammerError(error)) {
              crashed = entry.eventId;
              throw error;
            }
            failure = { error };
          }
          if (leaseFailure !== undefined) throw leaseFailure;
          if (failure?.error instanceof ArchiveEventWaitingError) {
            await state.repos.inbox.deferInbox(
              entry.eventId,
              claimToken,
              failure.error.message,
              failure.error.retryAt,
            );
            this.ctx.options.logger.debug(
              { guildId, eventId: entry.eventId, retryAt: failure.error.retryAt },
              'Archive event waits for an older event of its message',
            );
          } else if (failure === undefined) {
            await state.repos.inbox.ackInbox(entry.eventId, claimToken);
            this.retireCapture(state, entry.eventId);
            this.ctx.durations.inboxEvents += 1;
            this.ctx.durations.inboxLatencyMs += Math.max(0, Date.now() - entry.observedAt);
          } else {
            // Shutdown is not the event's failure; the claim is released uncounted below.
            if (this.ctx.stopped || state.signal.signal.aborted) break;
            await this.settleInboxFailure(state, guildId, entry, claimToken, failure.error);
          }
          outstanding.delete(entry.eventId);
          processed += 1;
        }
      } finally {
        clearInterval(timer);
        await renewing;
        for (const eventId of outstanding)
          await state.repos.inbox.releaseInbox(eventId, claimToken, eventId !== crashed);
      }
    }
    return processed;
  }

  /**
   * Each ready guild reduces its inbox in its own loop, independent of history
   * scans (see `ArchiveInboxLoop`): rounds of up to {@link INBOX_ROUND} events,
   * rechecked every `job_poll_seconds` while idle.
   */
  public startInboxLoop(guildId: string, state: ArchiveGuildState): void {
    if (this.ctx.options.inboxLoop === false || state.inbox.loop !== undefined || !state.ready)
      return;
    const loop = new ArchiveInboxLoop({
      round: async () => {
        const joined = state.inbox.draining !== undefined;
        return { retired: await this.drainInbox(guildId, INBOX_ROUND), joined };
      },
      roundSize: INBOX_ROUND,
      idleMs: this.ctx.options.config.job_poll_seconds * 1000,
      signal: state.signal.signal,
      onFailure: (error, failures) => {
        this.ctx.options.logger[isProgrammerError(error) ? 'error' : 'warn'](
          { guildId, failures, err: error },
          'Archive inbox round failed; retrying',
        );
      },
    });
    state.inbox.loop = loop;
    state.inbox.run = loop.run();
  }

  /** Settles the dirty entry of an event this process captured once the event is retired. */
  private retireCapture(state: ArchiveGuildState, eventId: string): void {
    const capture = state.captureVersions.get(eventId);
    if (capture === undefined) return;
    state.captureVersions.delete(eventId);
    state.dirty.settle(capture.messageId, capture.version);
  }

  /**
   * Routes a failed reconciliation (see `decideArchiveInboxFailure`). A live read
   * that failed after a newer event for the same message was captured is superseded:
   * that event reconciles the message again, so this one is acknowledged uncounted.
   * Dead events stay in the inbox for inspection but are never claimed or counted
   * as pending.
   */
  private async settleInboxFailure(
    state: ArchiveGuildState,
    guildId: string,
    entry: ArchiveInboxEntry,
    claimToken: string,
    error: unknown,
  ): Promise<void> {
    const log = { guildId, eventId: entry.eventId, channelId: entry.channelId, err: error };
    if (error instanceof ArchiveLiveReconcileError && (await this.isSuperseded(state, entry))) {
      await state.repos.inbox.ackInbox(entry.eventId, claimToken);
      this.retireCapture(state, entry.eventId);
      this.ctx.options.logger.info(log, 'Archive event reconciliation superseded by a newer event');
      return;
    }
    const now = Date.now();
    let decision = decideArchiveInboxFailure(classifyArchiveInboxFailure(error), entry, now);
    if (decision.kind === 'gap') {
      try {
        if (entry.channelId !== undefined)
          await this.recordLiveCoverageGap(
            state,
            entry.channelId,
            decision.access,
            decision.reason,
          );
        await state.repos.inbox.ackInbox(entry.eventId, claimToken);
        this.retireCapture(state, entry.eventId);
        this.ctx.options.logger.warn(
          { ...log, access: decision.access },
          'Archive event source inaccessible; coverage gap recorded',
        );
        return;
      } catch (recordError) {
        // The gap must be recorded before the event may disappear; retry it counted.
        this.ctx.options.logger.warn(
          { ...log, recordError },
          'Archive live coverage gap could not be recorded',
        );
        decision = decideArchiveInboxFailure({ kind: 'retry' }, entry, now);
      }
    }
    switch (decision.kind) {
      case 'gap':
        throw new TypeError('Archive coverage gap decision was not settled');
      case 'dead':
        await this.deadLetter(state, guildId, entry, claimToken, String(error), decision);
        return;
      case 'defer':
        await state.repos.inbox.deferInbox(
          entry.eventId,
          claimToken,
          String(error),
          decision.retryAt,
          decision,
        );
        this.ctx.options.logger.warn(
          { ...log, attempts: decision.attempts, retryAt: decision.retryAt },
          'Archive event reconciliation deferred',
        );
        return;
      default: {
        const unreachable: never = decision;
        throw new TypeError(`Unhandled archive inbox decision ${String(unreachable)}`);
      }
    }
  }

  private async deadLetter(
    state: ArchiveGuildState,
    guildId: string,
    entry: ArchiveInboxEntry,
    claimToken: string,
    reason: string,
    counters: ArchiveInboxCounters,
  ): Promise<void> {
    await state.repos.inbox.deadLetterInbox(
      entry.eventId,
      { kind: 'claim', token: claimToken },
      reason,
      Date.now(),
      counters,
    );
    this.retireCapture(state, entry.eventId);
    this.ctx.options.logger.error(
      {
        guildId,
        eventId: entry.eventId,
        channelId: entry.channelId,
        attempts: counters.attempts,
        claims: entry.claims,
        reason,
      },
      'Archive inbox event dead-lettered',
    );
  }

  /** A newer capture or a later open inbox event for the same message reconciles it again. */
  private async isSuperseded(state: ArchiveGuildState, entry: ArchiveInboxEntry): Promise<boolean> {
    if (entry.messageId === undefined) return false;
    const capture = state.captureVersions.get(entry.eventId);
    const current = state.dirty.versionOf(entry.messageId);
    if (capture !== undefined && current !== undefined && current > capture.version) return true;
    return state.repos.inbox.hasNewerOpenEvent(entry);
  }

  /** Mirrors history revalidation: a live 10003 or forbidden read is a known gap. */
  private async recordLiveCoverageGap(
    state: ArchiveGuildState,
    channelId: string,
    access: 'denied' | 'deleted',
    reason: string,
  ): Promise<void> {
    const previous = await state.repos.channels.findChannel(channelId);
    const now = Date.now();
    await mutateArchive(state, () =>
      state.repos.channels.upsertChannel({
        channelId,
        ...(previous?.name === undefined ? {} : { name: previous.name }),
        ...(previous?.type === undefined ? {} : { type: previous.type }),
        ...(previous?.parentId === undefined ? {} : { parentId: previous.parentId }),
        ...(previous?.everyoneCanView === undefined
          ? {}
          : { everyoneCanView: previous.everyoneCanView }),
        observedAt: now,
        access,
        discovery: {
          runId: 'live',
          gaps: access === 'deleted' ? [] : [reason],
          verifiedAt: now,
        },
      }),
    );
  }

  private async applyEvent(
    state: ArchiveGuildState,
    entry: ArchiveInboxEntry,
    reconcile = true,
  ): Promise<void> {
    if (entry.kind === 'gap') {
      // The inbox event is the gap's durable record until the flag itself is durable.
      await this.deps.continuity.flagGap(state, entry.observedAt);
      return;
    }
    const { messageId, channelId } = entry;
    if (entry.kind === 'delete') {
      await mutateArchive(state, () =>
        state.repos.messages.tombstone(messageId, channelId, entry.observedAt),
      );
      return;
    }
    let prior: ArchiveMessage | null;
    if (entry.kind === 'snapshot') {
      const { snapshot, channel } = entry.payload;
      // A message has no reactions when it is created, but a later event of it already
      // captured may have changed them; then the creation is read like an update.
      const create = entry.payload.create === true && !(await this.isSuperseded(state, entry));
      const location = await this.deps.locator.channelLocation(
        state,
        snapshot.channelId,
        channel,
        isAutomatedSource(snapshot),
      );
      const { outcome: saved, previous } = await this.deps.ingestor.saveSnapshot(
        state,
        snapshot,
        location,
        {
          bulk: false,
          ...(create ? { createdAt: entry.observedAt } : {}),
        },
      );
      if (saved === 'rejected') return;
      await this.deps.locator.registerChannel(state, snapshot.channelId, channel);
      // A complete creation needs no REST read: every later change is its own event.
      if (saved !== 'message' || create) return;
      prior = previous;
    } else {
      prior = await this.deps.ingestor.findMessage(state, messageId);
      if (prior === null) {
        // A reaction that overtook its message's open snapshot event (a deferred
        // creation) waits for it; otherwise history scans cover unseen messages.
        await this.awaitOlderSnapshot(state, entry);
        return;
      }
      // An interaction record keeps no reactions, so there is nothing to reread.
      if (prior.excludedFields?.includes('reactions') === true) return;
    }
    const scope = liveRefreshScope(entry, prior, state.continuity.continuousSince);
    if (scope.kind !== 'none')
      await mutateArchive(state, () =>
        state.repos.reactions.markReactionsStale(messageId, entry.observedAt),
      );
    if (!reconcile) return;
    // Reconcile missing partial fields and reaction changes via the same REST
    // manager. A 403 remains pending/incomplete; only an actual 10008 is deletion.
    try {
      const raw = await this.ctx.scheduler.run(
        `live:${channelId}:${messageId}`,
        'live',
        () =>
          this.deps.observations.read(state, () =>
            this.ctx.options.client.rest.get(Routes.channelMessage(channelId, messageId), {
              signal: state.signal.signal,
            }),
          ),
        {
          signal: state.signal.signal,
          guildId: String(state.conn.guildId),
          resource: { route: 'message', channelId: channelId },
        },
      );
      await this.deps.ingestor.ingest(state, raw as Record<string, unknown>, { scope });
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 10008))
        throw isProgrammerError(error) ? error : new ArchiveLiveReconcileError(error);
      await mutateArchive(state, () =>
        state.repos.messages.tombstone(messageId, channelId, Date.now()),
      );
    }
  }

  /** Throws {@link ArchiveEventWaitingError} while an older snapshot event of the message is open. */
  private async awaitOlderSnapshot(
    state: ArchiveGuildState,
    entry: Extract<ArchiveInboxEntry, { kind: 'reaction' }>,
  ): Promise<void> {
    const older = await state.repos.inbox.olderOpenSnapshot(entry);
    if (older !== null)
      throw new ArchiveEventWaitingError(
        Math.max(Date.now() + EVENT_WAIT_MS, older.nextAttemptAt ?? 0),
      );
  }
}
