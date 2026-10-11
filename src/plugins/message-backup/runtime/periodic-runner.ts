import { randomUUID } from 'node:crypto';
import type {
  ArchiveInboxEntry,
  ArchivePeriodicRecord,
  ArchivePeriodicRun,
  ArchiveTerminalStatus,
} from '../../../core/archive/types';
import { ARCHIVE_JOB_RECORDS_KEPT, ARCHIVE_LIMITS } from '../../../core/archive/limits';
import { archiveRetryDelay } from '../../../core/archive/schedule';
import { continuityFullChannelIds, continuityRescanFrom } from '../../../core/archive/continuity';
import { ProgressTracker } from '../flow/progress';
import type { GatewayContinuity } from './continuity';
import type { ArchiveInboxReducer } from './inbox-reducer';
import type { NotificationRecovery } from './notification-recovery';
import { archivePassHealth, type PeriodicPassResult } from './periodic-pass';
import type { ProgressPublisher } from './progress-publisher';
import { archiveGapReason, readCheckpoint } from './scan-contract';
import type { ScanRunner } from './scan-runner';
import {
  ArchiveScanInterruptedError,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** A run with blocking failures resumes at most this many times before it is closed. */
const PERIODIC_RUN_MAX_RESUMES = 3;

/** What a periodic pass needs from the worker's other collaborators. */
export interface PeriodicRunnerDependencies {
  readonly continuity: Pick<
    GatewayContinuity,
    'clearFullRequired' | 'flagGapSafely' | 'noGapSince' | 'settleCoverage'
  >;
  readonly inbox: Pick<ArchiveInboxReducer, 'drainInbox'>;
  readonly scanner: Pick<ScanRunner, 'scan'>;
  readonly progress: Pick<ProgressPublisher, 'close'>;
  readonly notifications: Pick<NotificationRecovery, 'deliverScheduleNotice'>;
}

/**
 * Runs periodic passes: claims the schedule, plans or resumes the periodic run,
 * scans it incrementally or fully and records the outcome.
 */
export class PeriodicRunner {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'logger'>,
    private readonly deps: PeriodicRunnerDependencies,
  ) {}

  private readonly recoveredSchedules = new Set<string>();

  public async scheduled(guildId: string, intervalMs: number): Promise<void> {
    const state = await this.ctx.initialize(guildId);
    const schedule = state.archive.schedule(intervalMs);
    if (!this.recoveredSchedules.has(guildId)) {
      await schedule.recover();
      this.recoveredSchedules.add(guildId);
    }
    // A notice whose delivery failed earlier is retried before the next pass.
    await this.deps.notifications.deliverScheduleNotice(guildId, schedule);
    // A not-ready guild still claims the pass, which ends skipped and counts as a failure.
    if (state.work.periodicBlocked()) return;
    const started = await schedule.start();
    if (started === null) return;
    let checkedAt = 0;
    let checking: Promise<boolean> | undefined;
    const shouldContinue = (): Promise<boolean> => {
      if (checking === undefined || Date.now() - checkedAt >= 1000) {
        checkedAt = Date.now();
        checking = schedule
          .read()
          .then((current) => current.enabled && current.pauseVersion === started.pauseVersion);
      }
      return checking;
    };
    const work = this.startPeriodic(state, guildId, shouldContinue);
    let pass: PeriodicPassResult | undefined;
    try {
      if (work !== undefined) pass = await work;
    } finally {
      // A control job may acquire the worker while the schedule claim is in flight.
      // Releasing an unused claim must preserve its due time for the next poll. A
      // pass that rejected outside its own error handling retries like a failure.
      await (
        work === undefined
          ? schedule.recover()
          : schedule.finish(
              started.revision,
              archiveRetryDelay(pass?.outcome ?? { kind: 'failed', consecutiveFailures: 1 }),
              archivePassHealth(pass),
            )
      ).catch((error: unknown) => {
        // Retry recovery on the next serialized pass if completion could not be saved.
        this.recoveredSchedules.delete(guildId);
        this.ctx.options.logger.error(
          { guildId, err: error },
          'Archive schedule completion failed',
        );
      });
    }
    if (work !== undefined) await this.deps.notifications.deliverScheduleNotice(guildId, schedule);
    if (pass !== undefined && 'error' in pass) throw pass.error;
  }

  public async run(guildId: string, shouldContinue?: () => Promise<boolean>): Promise<void> {
    const state = await this.ctx.initialize(guildId);
    const pass = await this.startPeriodic(state, guildId, shouldContinue);
    if (pass !== undefined && 'error' in pass) throw pass.error;
  }

  private startPeriodic(
    state: ArchiveGuildState,
    guildId: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<PeriodicPassResult> | undefined {
    return state.work.startPeriodic(
      () => this.runPeriodic(state, guildId, shouldContinue),
      () => this.deps.progress.close(state),
    );
  }

  private async runPeriodic(
    state: ArchiveGuildState,
    guildId: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<PeriodicPassResult> {
    if (!state.ready) return { outcome: { kind: 'skipped' } };
    let run: ArchivePeriodicRun | undefined;
    const runs = state.archive.periodicRuns;
    const passStartedAt = Date.now();
    try {
      // Events captured before the run is created, Gateway gaps above all, are
      // reduced first, so the run is planned with their effects.
      await this.deps.inbox.drainInbox(guildId);
      const previous = await runs.current();
      // The run boundary survives process restarts; channel checkpoints are useful
      // only when retries reuse their original identity and creation cutoff.
      const unfinished = previous !== null && previous.status !== 'complete' ? previous : undefined;
      const exhausted =
        unfinished !== undefined && (unfinished.blockedPasses ?? 0) > PERIODIC_RUN_MAX_RESUMES;
      const resumed = unfinished !== undefined && !exhausted;
      let deadLetters: string[] = [];
      if (resumed) run = unfinished;
      else {
        let fullChannelIds: string[] = [];
        if (exhausted) {
          const closure = await this.closeExhaustedRun(state, unfinished);
          fullChannelIds = closure.fullChannelIds;
          if (closure.clearFullRequired) await this.deps.continuity.clearFullRequired(state);
        }
        // A dead-lettered live event may hide an older edit the overlap window misses.
        const untraced = await this.untracedDeadLetters(state);
        deadLetters = untraced.map((entry) => entry.eventId);
        const unscoped = untraced.filter((entry) => !entry.channelId);
        if (unscoped.length > 0) {
          // A lost gap event or an event without a source has no channel to rescan.
          this.ctx.options.logger.warn(
            { guildId, eventIds: unscoped.map((entry) => entry.eventId) },
            'Archive dead letter without a source; full reconciliation required',
          );
          await this.deps.continuity.flagGapSafely(state);
        }
        fullChannelIds = [
          ...new Set([
            ...fullChannelIds,
            ...untraced.flatMap((entry) => (entry.channelId ? [entry.channelId] : [])),
            ...continuityFullChannelIds(state.continuity.breaks),
          ]),
        ];
        const rescanFrom = continuityRescanFrom(state.continuity.breaks);
        run = {
          _id: 'current',
          runId: `periodic:${randomUUID()}`,
          cutoff: Date.now(),
          full: state.continuity.fullRequired,
          status: 'running',
          blockedPasses: 0,
          consecutiveFailures: unfinished?.consecutiveFailures ?? 0,
          origin: {
            bootId: this.ctx.bootId,
            gapVersion: state.continuity.gapVersion,
            breakIndex: state.continuity.breakIndex,
          },
          ...(state.continuity.fullRequired || fullChannelIds.length === 0
            ? {}
            : { fullChannelIds }),
          ...(state.continuity.fullRequired || rescanFrom === undefined ? {} : { rescanFrom }),
        };
      }
      const current = run;
      const initialProgress = new ProgressTracker({
        cutoff: new Date(current.cutoff),
        startedAt: current.cutoff,
        work: 'periodic',
        scanId: current.runId,
      }).snapshot();
      await runs.replace({
        ...current,
        status: 'running',
        progress: initialProgress,
        passStartedAt,
      });
      // Traced only once the run that rescans their sources is durable.
      if (deadLetters.length > 0)
        await state.repos.inbox.traceDeadLetters(deadLetters, current.runId);
      const { interruption, ...result } = await this.deps.scanner.scan(state, {
        runId: current.runId,
        cutoff: current.cutoff,
        mode: {
          kind: 'periodic',
          full: current.full,
          coverage: current,
          ...(shouldContinue === undefined ? {} : { shouldContinue }),
        },
      });
      const blocked = result.status === 'partial' && interruption === undefined;
      await runs.update(current.runId, {
        status: result.status,
        result,
        progress: state.progress?.snapshot(),
        blockedPasses: (current.blockedPasses ?? 0) + (blocked ? 1 : 0),
        // Only a scan that reached its end resets the failure backoff.
        consecutiveFailures: interruption === undefined ? 0 : (current.consecutiveFailures ?? 0),
      });
      await this.deps.progress.close(state, true);
      await this.recordPass(state, current, passStartedAt, {
        status: result.status === 'complete' ? 'complete' : blocked ? 'partial' : 'cancelled',
        counts: { ...result.counts },
        gaps: [...result.gaps],
        issueCount: result.issues.length,
      });
      if (result.status === 'complete') {
        await this.deps.continuity.settleCoverage(state, current);
        return { outcome: { kind: 'complete' } };
      }
      return blocked
        ? { outcome: { kind: 'partial' }, reason: archiveGapReason(result.issues[0] ?? '') }
        : { outcome: { kind: 'interrupted' } };
    } catch (error) {
      const interrupted =
        error instanceof ArchiveScanInterruptedError ||
        state.signal.signal.aborted ||
        state.work.periodicPreempted();
      const consecutiveFailures = (run?.consecutiveFailures ?? 0) + (interrupted ? 0 : 1);
      if (run !== undefined) {
        state.progress?.gap({ reason: archiveGapReason(String(error)) });
        state.progress?.finish('partial');
        // Thrown passes never count toward the resume cap; they back off instead.
        await runs
          .update(run.runId, {
            status: 'partial',
            result: { issues: [String(error)] },
            progress: state.progress?.snapshot(),
            consecutiveFailures,
          })
          .catch((saveError: unknown) => {
            this.ctx.options.logger.warn(
              { guildId, err: saveError },
              'Archive periodic failure could not be recorded',
            );
          });
        await this.deps.progress.close(state, true);
        await this.recordPass(state, run, passStartedAt, {
          status: interrupted ? 'cancelled' : 'failed',
          issueCount: 1,
        });
      }
      if (interrupted) return { outcome: { kind: 'interrupted' } };
      return {
        outcome: { kind: 'failed', consecutiveFailures },
        error,
        reason: archiveGapReason(String(error)),
      };
    }
  }

  /**
   * A finished pass becomes one record for `/archive status`; older finished records
   * are pruned. Record keeping never fails the pass.
   */
  private async recordPass(
    state: ArchiveGuildState,
    run: ArchivePeriodicRun,
    startedAt: number,
    outcome: { status: ArchiveTerminalStatus } & Omit<ArchivePeriodicRecord['result'], 'cutoff'>,
  ): Promise<void> {
    const guildId = String(state.conn.guildId);
    const requestId = randomUUID();
    try {
      await state.repos.jobs.insertJobRecord({
        jobId: `${guildId}:periodic:${requestId}`,
        requestId,
        guildId,
        command: 'periodic',
        options: { cutoff: run.cutoff, full: run.full },
        runId: run.runId,
        status: outcome.status,
        result: {
          cutoff: run.cutoff,
          issueCount: outcome.issueCount,
          ...(outcome.counts === undefined ? {} : { counts: outcome.counts }),
          ...(outcome.gaps === undefined ? {} : { gaps: outcome.gaps }),
        },
        cancelRequested: false,
        createdAt: startedAt,
        startedAt,
        finishedAt: Date.now(),
      });
      await state.repos.jobs.pruneJobRecords(ARCHIVE_JOB_RECORDS_KEPT);
    } catch (error) {
      this.ctx.options.logger.warn({ guildId, err: error }, 'Archive pass record not saved');
    }
  }

  /** Dead letters not yet reported by a periodic run. */
  private async untracedDeadLetters(
    state: ArchiveGuildState,
  ): Promise<Pick<ArchiveInboxEntry, 'eventId' | 'channelId'>[]> {
    return state.repos.inbox.untracedDeadLetters(ARCHIVE_LIMITS.batchDocuments);
  }

  /**
   * Plans the replacement for a run whose blocking failures outlasted its resumes.
   * Its cutoff is abandoned; the next run retries only the sources it left
   * unfinished (fully, when it was a full reconciliation) and scans the rest
   * incrementally from their completed watermarks. The caller applies
   * `clearFullRequired`: completed sources already reconciled through the closed
   * cutoff unless sources stayed unknown or a Gateway gap occurred since it began.
   * Restart downtime is covered separately by the new run's `rescanFrom`.
   */
  private async closeExhaustedRun(
    state: ArchiveGuildState,
    closed: ArchivePeriodicRun,
  ): Promise<{ fullChannelIds: string[]; clearFullRequired: boolean }> {
    const open = (await state.repos.channels.listChannels()).filter((channel) => {
      const checkpoint = readCheckpoint(channel, 'periodic');
      return (
        (channel.access === 'readable' || channel.access === 'unknown') &&
        !channel.channelId.startsWith('guild:') &&
        !(checkpoint?.runId === closed.runId && checkpoint.complete)
      );
    });
    const unfinished = open.map((channel) => channel.channelId);
    const fullChannelIds = closed.full
      ? unfinished
      : unfinished.filter((channelId) => closed.fullChannelIds?.includes(channelId) === true);
    const clearFullRequired =
      closed.full &&
      !open.some((channel) => channel.access === 'unknown') &&
      this.deps.continuity.noGapSince(state, closed);
    this.ctx.options.logger.warn(
      {
        guildId: String(state.conn.guildId),
        runId: closed.runId,
        blockedPasses: closed.blockedPasses,
        unfinished: unfinished.length,
      },
      'Archive periodic run closed after repeated blocking failures',
    );
    return { fullChannelIds, clearFullRequired };
  }
}
