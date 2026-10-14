import type { Guild, GuildBasedChannel } from 'discord.js';
import type {
  ArchiveChannel,
  ArchiveHistoryCheckpoint,
  ArchiveScanKind,
  PeriodicHistory,
} from '../../../core/archive/types';
import { continuityFullChannelIds } from '../../../core/archive/continuity';
import { ARCHIVE_PROGRESS_INTERVAL_MS } from '../../../core/archive/limits';
import type { DiscoveryGap, DiscoveryLocation } from '../flow/discovery';
import { archivePerformanceLog } from '../flow/performance-log';
import { estimatePeriodicWork, updatePeriodicHistory } from '../flow/periodic-estimate';
import { ProgressTracker } from '../flow/progress';
import { ArchiveObservationScope } from './dirty-tracker';
import { scanArchiveHistory, type HistoryHooks } from './history-scan';
import type { HistoryPageResult } from './ingestor';
import { ArchiveJobCancellation, ArchiveJobStoppedError } from './job-cancellation';
import {
  archiveGapReason,
  readCheckpoint,
  type ArchiveScanCoverage,
  type ArchiveScanResult,
  type ScanRequest,
  type ScanRunnerDependencies,
} from './scan-contract';
import { inventoriedChannel, pageStatistics, revalidatedChannel } from './scan-records';
import { FullBackupSourceOrder } from './source-order';
import { ARCHIVE_SOURCE_RETRY } from './source-failure';
import {
  ArchiveScanInterruptedError,
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

type HistoryResult = Awaited<ReturnType<typeof scanArchiveHistory>>;
export type ScanPassContext = ArchiveWorkerContextFor<
  'client' | 'config' | 'logger' | 'sourceRetryBaseMs' | 'stopCheckClock'
>;

/**
 * One history scan of a guild and the state it keeps while it runs: the channel
 * records it has seen, page results awaiting their checkpoint, evidence scopes and
 * the signals that pause, stop or cancel it. Its methods are the history hooks.
 */
export class ScanPass {
  private readonly guildId: string;
  private readonly kind: ArchiveScanKind;
  private readonly full: boolean;
  private readonly jobId: string | undefined;
  private readonly coverage: ArchiveScanCoverage | undefined;
  private readonly shouldContinue: (() => Promise<boolean>) | undefined;
  /** A stop request or shutdown; it ends a full backup cancelled. */
  private readonly cancellation = new AbortController();
  /** A storage or schedule pause; the scan ends partial. */
  private readonly capacityPause = new AbortController();
  private readonly signal: AbortSignal;
  private pauseReason: string | undefined;
  private readonly jobCancellation: ArchiveJobCancellation | undefined;
  private readonly progress: ProgressTracker;
  /** Full backups dispatch the largest sources first; periodic passes keep discovery order. */
  private readonly sourceOrder: FullBackupSourceOrder | undefined;
  private gapVersion = 0;
  private channels = new Map<string, ArchiveChannel>();
  private readonly priors = new Map<string, PeriodicHistory>();
  private readonly pageResults = new Map<string, HistoryPageResult>();
  private readonly priorCutoffs = new Map<string, number>();
  private readonly discovered = new Set<string>();
  /**
   * Evidence that no consumer released is unpinned when its source completes
   * (overlap messages below the incremental boundary) or when the scan ends.
   */
  private readonly observed = new ArchiveObservationScope();
  private readonly sourceScopes = new Map<string, ArchiveObservationScope>();
  private scanEnded = false;

  public constructor(
    private readonly ctx: ScanPassContext,
    private readonly deps: ScanRunnerDependencies,
    private readonly state: ArchiveGuildState,
    private readonly request: ScanRequest,
  ) {
    const { mode, runId, cutoff } = request;
    this.guildId = String(state.conn.guildId);
    this.kind = mode.kind;
    this.full = mode.kind === 'full-backup' || mode.full;
    this.jobId = mode.kind === 'full-backup' ? mode.jobId : undefined;
    this.coverage = mode.kind === 'periodic' ? mode.coverage : undefined;
    this.shouldContinue = mode.kind === 'periodic' ? mode.shouldContinue : undefined;
    const preemption = mode.kind === 'periodic' ? state.work.periodicSignal : undefined;
    this.signal = AbortSignal.any([
      ...(preemption === undefined ? [] : [preemption]),
      state.signal.signal,
      this.cancellation.signal,
      this.capacityPause.signal,
    ]);
    deps.inbox.beginPass(state);
    // A stop request ends a full backup at its next boundary, keeping its checkpoints.
    // Only a stop request or shutdown stops the job; a storage pause is not a stop.
    this.jobCancellation =
      this.jobId === undefined
        ? undefined
        : new ArchiveJobCancellation(
            this.jobId,
            async (id) => (await state.repos.jobs.getJob(id))?.cancelRequested === true,
            {
              signal: state.signal.signal,
              logger: ctx.options.logger,
              now: ctx.options.stopCheckClock,
            },
          );
    this.progress =
      this.jobId === undefined
        ? new ProgressTracker({
            cutoff: new Date(cutoff),
            startedAt: cutoff,
            work: 'periodic',
            scanId: runId,
            logger: ctx.options.logger,
          })
        : (state.progress ??
          new ProgressTracker({
            cutoff: new Date(cutoff),
            work: 'full-backup',
            jobId: this.jobId,
            runId,
            logger: ctx.options.logger,
          }));
    state.progress = this.progress;
    this.sourceOrder =
      mode.kind === 'full-backup'
        ? new FullBackupSourceOrder(state.repos.messages, ctx.options.logger, {
            guildId: this.guildId,
            runId,
            cutoff,
          })
        : undefined;
  }

  public async run(): Promise<ArchiveScanResult> {
    const { state, progress } = this;
    progress.setPhase('discovery');
    await this.deps.progress.notify(this.guildId, state, this.jobId, true);
    this.gapVersion = state.continuity.gapVersion;
    const guild = await this.ctx.options.client.guilds.fetch(this.guildId);
    this.channels = new Map(
      (await state.repos.channels.listChannels()).map((channel) => [channel.channelId, channel]),
    );
    const knownChannelIds = new Set(
      [...this.channels.keys()].filter((id) => !id.startsWith('guild:')),
    );
    for (const value of await state.repos.channels.fetchChannelIds()) knownChannelIds.add(value);
    for (const value of await state.repos.messages.messageChannelIds()) knownChannelIds.add(value);
    for (const channel of this.channels.values())
      if (channel.access === 'deleted') knownChannelIds.delete(channel.channelId);
    this.restoreCheckpoints();
    const result = await scanArchiveHistory(
      guild,
      this.ctx.options.client,
      this.ctx.options.logger,
      this.hooks(guild, [...knownChannelIds]),
    ).finally(() => {
      this.scanEnded = true;
      this.observed.close();
      for (const scope of this.sourceScopes.values()) scope.close();
    });
    return this.finish(result);
  }

  /** Earlier passes of this run, when it resumes, count toward its progress. */
  private restoreCheckpoints(): void {
    const { progress } = this;
    for (const channel of this.channels.values()) {
      const checkpoint = readCheckpoint(channel, this.kind);
      if (checkpoint !== undefined) this.priorCutoffs.set(channel.channelId, checkpoint.cutoff);
      if (checkpoint?.estimatePrevious !== undefined)
        this.priors.set(channel.channelId, checkpoint.estimatePrevious);
      if (checkpoint?.runId === this.request.runId && checkpoint.scanned !== undefined) {
        progress.observe('history', checkpoint.scanned, checkpoint.admitted ?? 0);
        progress.commit(
          'history',
          checkpoint.scanned,
          channel.channelId,
          checkpoint.pageSequence ?? 0,
          true,
        );
        const statistics = checkpoint.statistics;
        if (statistics !== undefined) progress.messageCounts(statistics.messages);
        progress.reactionDiscovered(statistics?.reactions ?? 0);
        progress.reactionCompleted(statistics?.reactions ?? 0);
        progress.reactionStale(statistics?.staleReactions ?? 0);
      }
    }
  }

  private hooks(guild: Guild, knownChannelIds: readonly string[]): HistoryHooks {
    const { coverage, progress, sourceOrder } = this;
    return {
      runId: this.request.runId,
      cutoff: this.request.cutoff,
      full: this.full,
      ...(coverage?.fullChannelIds === undefined
        ? {}
        : { fullChannelIds: coverage.fullChannelIds }),
      ...(coverage?.rescanFrom === undefined ? {} : { rescanFrom: coverage.rescanFrom }),
      overlapMinutes: this.ctx.options.config.overlap_minutes,
      concurrency: this.ctx.options.config.concurrency,
      signal: this.signal,
      failed: (reason) => this.failed(reason),
      phase: (phase) => {
        progress.setPhase(phase);
        void this.deps.progress.notify(this.guildId, this.state, this.jobId, true);
      },
      pipelineBudget: this.ctx.pipelineBudget,
      ...(this.ctx.options.sourceRetryBaseMs === undefined
        ? {}
        : {
            sourceRetry: {
              ...ARCHIVE_SOURCE_RETRY,
              baseMs: this.ctx.options.sourceRetryBaseMs,
            },
          }),
      fetched: (_channelId, count) => progress.messageCounts({ fetched: count }),
      onActivity: (channelId, activity) =>
        progress.activity(
          channelId,
          activity === undefined
            ? undefined
            : {
                ...activity,
                name: this.channels.get(channelId)?.name ?? channelId,
                direction: 'before',
              },
        ),
      completed: (channelId) => {
        progress.completeSource(channelId);
        this.sourceScopes.get(channelId)?.close();
        this.sourceScopes.delete(channelId);
      },
      knownChannelIds,
      inventory: (locations, gaps, readableIds) =>
        this.inventory(guild, locations, gaps, readableIds),
      revalidated: (channelId, access, channel, reason) =>
        this.revalidated(channelId, access, channel, reason),
      discovered: (ids) => this.discoveredSources(ids),
      ...(sourceOrder === undefined
        ? {}
        : { order: (channels) => sourceOrder.order(channels, this.channels, this.signal) }),
      load: (channelId) => this.load(channelId),
      checkpoint: (channel, checkpoint) => this.saveCheckpoint(channel, checkpoint),
      // Live events are reduced by the guild's inbox loop; pages never wait for it.
      consume: (raw, channel) => this.consume(raw, channel),
      consumePage: (raws, channel) => this.consumePage(raws, channel),
      afterPage: () => this.checkBoundary(),
      request: (key, operation, requestSignal = this.signal) =>
        this.read(key, operation, requestSignal),
      progress: (channelId, count, checkpoint) => this.recordProgress(channelId, count, checkpoint),
    };
  }

  /** A storage shortage pauses the scan; other failures are reported by the result. */
  private failed(reason: string): void {
    if (reason.includes('storage headroom exhausted') || reason.includes('capacity is unknown')) {
      this.pauseReason = reason;
      this.progress.pause(reason);
      this.capacityPause.abort();
    }
  }

  private async checkSchedule(): Promise<void> {
    if (this.shouldContinue !== undefined && !(await this.shouldContinue())) {
      this.pauseReason = 'Periodic archive disabled';
      this.capacityPause.abort();
      throw new ArchiveScanInterruptedError(this.pauseReason);
    }
  }

  private async checkBoundary(): Promise<void> {
    await this.checkSchedule();
    if (this.capacityPause.signal.aborted)
      throw new ArchiveScanInterruptedError(this.pauseReason ?? 'Archive scan paused');
    try {
      await this.jobCancellation?.checkpoint();
    } catch (error) {
      if (error instanceof ArchiveJobStoppedError) this.cancellation.abort();
      throw error;
    }
    if (this.signal.aborted) throw new ArchiveScanInterruptedError('Archive scan stopped');
  }

  private scopeFor(key: string): ArchiveObservationScope {
    // History page keys are `history:<channelId>:<before>` (see scanArchiveHistory).
    const channelId = /^history:(\d+):/.exec(key)?.[1];
    if (channelId === undefined || this.scanEnded) return this.observed;
    let scope = this.sourceScopes.get(channelId);
    if (scope === undefined) {
      scope = new ArchiveObservationScope();
      this.sourceScopes.set(channelId, scope);
    }
    return scope;
  }

  /**
   * Discord delivered no events for a source while the bot could not read it, so a
   * regained source scans fully in the next periodic run (created after this
   * break); a full backup's cutoff may predate the regained window.
   */
  private async regained(
    channelId: string,
    previous: ArchiveChannel | undefined,
    access: ArchiveChannel['access'],
  ): Promise<void> {
    if (access === 'readable' && previous !== undefined && previous.access !== 'readable')
      await this.deps.continuity.recordChannelBreak(this.state, channelId, Date.now());
  }

  private async inventory(
    guild: Guild,
    locations: readonly DiscoveryLocation[],
    gaps: readonly DiscoveryGap[],
    readableIds: readonly string[],
  ): Promise<void> {
    const { state } = this;
    for (const gap of gaps)
      this.progress.gap({
        sourceId: gap.channelId,
        name: locations.find((location) => location.id === gap.channelId)?.name,
        reason: archiveGapReason(gap.reason),
      });
    const readable = new Set(readableIds);
    for (const location of locations) {
      const previous = this.channels.get(location.id);
      const record = inventoriedChannel(
        previous,
        location,
        gaps,
        readable.has(location.id),
        this.deps.locator.locationVisibility(guild, location),
        this.request.runId,
      );
      await mutateArchive(state, () => state.repos.channels.upsertChannel(record));
      await this.regained(location.id, previous, record.access);
      this.channels.set(location.id, { ...previous, ...record });
    }
  }

  private async revalidated(
    channelId: string,
    access: ArchiveChannel['access'],
    channel: GuildBasedChannel | undefined,
    reason: string | undefined,
  ): Promise<void> {
    const { state } = this;
    if (reason !== undefined && access !== 'deleted')
      this.progress.gap({
        sourceId: channelId,
        name: channel?.name ?? this.channels.get(channelId)?.name,
        reason: archiveGapReason(reason),
      });
    const previous = this.channels.get(channelId);
    const record = revalidatedChannel(
      previous,
      channelId,
      access,
      channel,
      reason,
      this.request.runId,
    );
    await mutateArchive(state, () => state.repos.channels.upsertChannel(record));
    await this.regained(channelId, previous, access);
    this.channels.set(channelId, { ...previous, ...record });
  }

  private discoveredSources(ids: readonly string[]): void {
    const { progress } = this;
    for (const id of ids) this.discovered.add(id);
    progress.setSources(this.discovered.size);
    if (this.full) return;
    const estimate = estimatePeriodicWork([...this.discovered], this.priors, this.request.cutoff, {
      policyHash: this.ctx.policyHash,
    });
    progress.setTotal(
      'history',
      estimate.total !== undefined &&
        estimate.total >= progress.checkpoint().phases.history.committed
        ? estimate.total
        : undefined,
      'estimated',
      'messages',
    );
    if (progress.checkpoint().phases.history.rates.length < 3)
      progress.seedRates('history', estimate.rates);
  }

  private async load(
    channelId: string,
  ): Promise<{ checkpoint?: ArchiveHistoryCheckpoint; lastMessageId?: string }> {
    const checkpoint = readCheckpoint(this.channels.get(channelId), this.kind);
    const cursor = await this.state.repos.channels.fetchCursor(channelId);
    return {
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(cursor === undefined ? {} : { lastMessageId: cursor }),
    };
  }

  private async saveCheckpoint(
    channel: GuildBasedChannel,
    checkpoint: ArchiveHistoryCheckpoint,
  ): Promise<void> {
    const { state, kind, ctx } = this;
    const { cutoff } = this.request;
    const checkpointStarted = performance.now();
    const old = readCheckpoint(this.channels.get(channel.id), kind);
    const baseline = old?.estimatePrevious;
    const page = this.pageResults.get(channel.id);
    if (page !== undefined && (checkpoint.pageSequence ?? 0) > (old?.pageSequence ?? 0)) {
      Object.assign(checkpoint, {
        statistics: pageStatistics(old?.statistics, page, checkpoint.pageAdmitted ?? 0),
      });
    }
    if (baseline !== undefined) checkpoint.estimatePrevious = baseline;
    if (
      !this.full &&
      checkpoint.complete &&
      checkpoint.startedAt !== undefined &&
      old !== undefined
    ) {
      const priorCutoff = baseline?.lastCutoff ?? this.priorCutoffs.get(channel.id) ?? cutoff;
      if (cutoff > priorCutoff)
        checkpoint.estimatePrevious = updatePeriodicHistory(baseline, {
          cutoff,
          scanned: checkpoint.scanned ?? 0,
          elapsedMs: Math.max(1, Date.now() - checkpoint.startedAt),
          windowMs: cutoff - priorCutoff,
          policyHash: ctx.policyHash,
        });
    }
    const saved = checkpoint as unknown as Record<string, unknown>;
    await mutateArchive(state, () =>
      state.repos.channels.upsertChannel({
        channelId: channel.id,
        name: channel.name,
        type: channel.type,
        observedAt: Date.now(),
        access: 'readable',
        ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
        checkpoints: { [kind]: saved },
      }),
    );
    const duration = performance.now() - checkpointStarted;
    ctx.durations.checkpointMs += duration;
    ctx.pipelineBudget.record('checkpoint', duration);
    if (Date.now() - ctx.performanceReportedAt >= 30_000) {
      ctx.performanceReportedAt = Date.now();
      ctx.options.logger.info(
        archivePerformanceLog(
          ctx.pipelineBudget.snapshot(),
          ctx.telemetry.snapshot(),
          ctx.scheduler.snapshot(),
        ),
        'Archive pipeline performance',
      );
    }
    const previous = this.channels.get(channel.id);
    this.channels.set(channel.id, {
      ...previous,
      channelId: channel.id,
      name: channel.name,
      type: channel.type,
      observedAt: Date.now(),
      access: 'readable',
      checkpoints: { ...previous?.checkpoints, [kind]: saved },
    });
    if (checkpoint.complete && checkpoint.latest !== undefined) {
      const latest = checkpoint.latest;
      await mutateArchive(state, () =>
        state.repos.channels.advanceFetchCursor(channel.id, channel.name, latest),
      );
    }
  }

  private async consume(
    raw: Record<string, unknown>,
    channel: GuildBasedChannel,
  ): Promise<boolean> {
    return this.deps.ingestor.ingest(this.state, raw, {
      channel,
      signal: this.signal,
      onReactionActivity: (counts) =>
        this.progress.activity(channel.id, { step: 'reactions', ...counts, provisional: true }),
      onReactionProgress: async (estimate) => {
        await this.checkSchedule();
        this.progress.setCurrentPhaseEstimate(estimate);
        await this.deps.progress.notify(this.guildId, this.state, this.jobId);
      },
    });
  }

  private async consumePage(
    raws: readonly Record<string, unknown>[],
    channel: GuildBasedChannel,
  ): Promise<readonly boolean[]> {
    const page = await this.deps.ingestor.ingestPage(
      this.state,
      raws,
      channel,
      this.signal,
      () => this.checkBoundary(),
      // Only incremental periodic scans of sources whose live events all arrived,
      // including breaks recorded after a resumed run was planned.
      this.kind === 'periodic' &&
        !this.full &&
        this.coverage?.fullChannelIds?.includes(channel.id) !== true &&
        !continuityFullChannelIds(this.state.continuity.breaks).includes(channel.id),
    );
    this.pageResults.set(channel.id, page);
    return page.admitted;
  }

  private async read<T>(
    key: string,
    operation: () => Promise<T>,
    requestSignal: AbortSignal,
  ): Promise<T> {
    await this.checkSchedule();
    return this.ctx.scheduler.run(
      key,
      'history',
      () => this.deps.observations.read(this.state, operation, this.scopeFor(key)),
      { signal: requestSignal, guildId: this.guildId },
    );
  }

  private async recordProgress(
    channelId: string,
    count: number,
    checkpoint: ArchiveHistoryCheckpoint,
  ): Promise<void> {
    const { progress } = this;
    if (progress.commit('history', count, channelId, checkpoint.pageSequence ?? 0)) {
      progress.observe('history', count, checkpoint.pageAdmitted ?? 0);
      progress.messageCounts({
        scanned: count,
        admitted: checkpoint.pageAdmitted ?? 0,
        excluded: Math.max(0, count - (checkpoint.pageAdmitted ?? 0)),
      });
      const page = this.pageResults.get(channelId);
      if (page !== undefined) {
        progress.messageCounts(page.counts);
        progress.reactionDiscovered(page.reactions);
        progress.reactionCompleted(page.reactions);
        progress.reactionStale(page.staleReactions);
      }
      this.pageResults.delete(channelId);
    }
    await this.deps.progress.notify(this.guildId, this.state, this.jobId);
  }

  /**
   * Judges the scan once the history pass ended. The pass waits for one inbox round,
   * so events reduced meanwhile need not keep it partial. Only events observed by
   * the cutoff belong to this pass; later ones are live backlog.
   */
  private async finish(result: HistoryResult): Promise<ArchiveScanResult> {
    const { state, progress, kind, ctx } = this;
    const { runId, cutoff } = this.request;
    await this.deps.inbox.drainInboxSafely(state);
    const {
      pending: pendingEvents,
      live: liveBacklog,
      oldestLiveAt,
    } = await state.repos.inbox.inboxBacklog(cutoff);
    progress.setExtras({
      live: {
        pending: liveBacklog,
        oldestAgeMs: oldestLiveAt === undefined ? 0 : Math.max(0, Date.now() - oldestLiveAt),
        windowMs: ARCHIVE_PROGRESS_INTERVAL_MS,
      },
    });
    // Dead letters traced to this run: their sources are rescanned fully, but the
    // lost live change is reported as a known gap instead of blocking completion.
    const deadLetters = kind === 'periodic' ? await state.repos.inbox.tracedDeadLetters(runId) : [];
    const deadLetterGaps = [
      ...new Set(
        deadLetters.map((entry) => `${entry.channelId ?? 'unknown'}: live-event-dead-lettered`),
      ),
    ];
    const blocking = [...result.issues];
    if (pendingEvents > 0)
      blocking.push(
        `${pendingEvents} live archive event(s) observed before the cutoff remain unprocessed`,
      );
    if (state.continuity.gapVersion !== this.gapVersion)
      blocking.push('Gateway gap during scan; full reconciliation remains required');
    if (kind === 'periodic' && state.work.periodicPreempted())
      this.pauseReason = 'Queued archive maintenance';
    const { pauseReason } = this;
    if (pauseReason !== undefined && !blocking.includes(pauseReason)) blocking.push(pauseReason);
    // Known gaps cannot be closed by retrying, so a run completes with them.
    const issues = blocking;
    const gaps = [...result.gaps, ...deadLetterGaps];
    for (const issue of [...issues, ...gaps]) {
      const sourceId = /^(\d+):/.exec(issue)?.[1];
      if (sourceId !== undefined || progress.snapshot().gapCount === 0)
        progress.gap({
          sourceId,
          name: sourceId === undefined ? undefined : this.channels.get(sourceId)?.name,
          reason: archiveGapReason(issue),
        });
    }
    const cancelled = this.cancellation.signal.aborted || state.signal.signal.aborted;
    const status = cancelled ? 'cancelled' : issues.length > 0 ? 'partial' : 'complete';
    if (status === 'complete')
      for (const phase of ['discovery', 'history', 'reactions', 'verification'] as const)
        progress.setTotal(phase, progress.checkpoint().phases[phase].committed);
    progress.finish(status, pauseReason);
    return {
      status,
      counts: {
        scanned: result.scanned,
        channels: result.channels,
        written: progress.snapshot().messages.inserted + progress.snapshot().messages.updated,
        staleReactions: progress.snapshot().reactions.stale ?? 0,
        pendingEvents,
        liveBacklog,
        ...(kind === 'periodic' ? { deadLetters: deadLetters.length } : {}),
      },
      details: {
        progress: {
          ...progress.snapshot(),
          rest: ctx.telemetry.snapshot(),
          scheduler: ctx.scheduler.snapshot(),
        },
      },
      issues,
      gaps,
      ...(cancelled
        ? { interruption: 'cancelled' }
        : pauseReason === undefined
          ? {}
          : { interruption: pauseReason }),
    };
  }
}
