import type {
  ArchiveFullBackupJob,
  ArchiveFullBackupResult,
  ArchiveRunOrigin,
  ArchiveTerminalStatus,
} from '../../../core/archive/types';
import { ARCHIVE_JOB_RECORDS_KEPT } from '../../../core/archive/limits';
import { ARCHIVE_PROCESS_ID } from '../../../infra/archive/owner';
import type { ArchiveFullBackupPatch } from '../../../persistence/repositories/archive-job.repo';
import { ProgressTracker } from '../flow/progress';
import type { GatewayContinuity } from './continuity';
import type { ArchiveInboxReducer } from './inbox-reducer';
import { ArchiveJobStoppedError } from './job-cancellation';
import { deferredRetryDelay, type NotificationRecovery } from './notification-recovery';
import type { ProgressPublisher } from './progress-publisher';
import type { ReactionRefresher } from './reaction-refresh';
import { archiveGapReason } from './scan-contract';
import type { ScanRunner } from './scan-runner';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/** Bounded retries for a job's terminal write: 1, 2, 4 and 8 seconds apart. */
const TERMINAL_WRITE_ATTEMPTS = 5;
const TERMINAL_WRITE_BACKOFF_MS = 1000;
const RELEASED_FIELDS = ['activeSlot', 'claimToken', 'leaseUntil'] as const;

/** What a full backup needs from the worker's other collaborators. */
export interface JobRunnerDependencies {
  readonly continuity: Pick<GatewayContinuity, 'settleCoverage'>;
  readonly inbox: Pick<ArchiveInboxReducer, 'drainInbox' | 'drainInboxSafely'>;
  readonly reactions: Pick<ReactionRefresher, 'sweepGarbage'>;
  readonly scanner: Pick<ScanRunner, 'scan'>;
  readonly progress: Pick<ProgressPublisher, 'close'>;
  readonly notifications: Pick<NotificationRecovery, 'publishBackupResult' | 'retryBackupResults'>;
}

/**
 * Runs full-backup jobs: claims a queued backup, preempting a periodic pass, scans
 * it with its fixed cutoff and saves its terminal state with bounded retries.
 */
export class JobRunner {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'logger' | 'terminalRetryBaseMs'>,
    private readonly deps: JobRunnerDependencies,
  ) {}

  public async poll(guildId: string): Promise<void> {
    if (this.ctx.stopped) return;
    const state = await this.ctx.initialize(guildId);
    return state.work.joinJobPoll(() => this.runJobs(state, guildId));
  }

  /**
   * A queued full backup preempts a periodic pass, which waits until it ends. An
   * unsaved terminal state is retried first and blocks new work until it is saved.
   */
  private async runJobs(state: ArchiveGuildState, guildId: string): Promise<void> {
    await state.work.runJob(
      async () =>
        (await state.repos.jobs.hasQueuedBackup()) || state.work.pendingFinish !== undefined,
      () => state.writer.drain(),
      async () => {
        if (state.work.pendingFinish !== undefined) {
          await this.retryPendingFinish(state, guildId);
          if (state.work.pendingFinish !== undefined) return;
        }
        await this.deps.notifications.retryBackupResults(guildId, state).catch((error: unknown) => {
          this.ctx.options.logger.warn(
            { guildId, err: error },
            'Archive notification retry deferred',
          );
        });
        const job = await state.repos.jobs.claimJob(ARCHIVE_PROCESS_ID, Date.now(), 60_000);
        if (job === undefined) {
          // A guild without its own inbox loop reduces the inbox on each poll.
          if (state.inbox.run === undefined) await this.deps.inbox.drainInbox(guildId);
          await this.deps.reactions.sweepGarbage(state);
          return;
        }
        await this.runFullBackup(state, guildId, job);
      },
    );
  }

  /**
   * Runs a full backup as its own full scan with the fixed cutoff and the
   * full-backup checkpoints, so a stop or restart resumes where it left off. It
   * ends `complete` when only known gaps remain, `cancelled` when stopped,
   * `partial` with blocking failures, a storage pause or capture-only mode, and
   * `failed` when it threw. Shutdown leaves it running; the next boot queues it again.
   */
  private async runFullBackup(
    state: ArchiveGuildState,
    guildId: string,
    claimed: ArchiveFullBackupJob,
  ): Promise<void> {
    let job = claimed;
    const cutoff = job.options.cutoff;
    const runId = job.runId;
    state.progress = undefined;
    let terminal: ArchiveFullBackupResult | undefined;
    try {
      if (!Number.isSafeInteger(cutoff) || runId === undefined)
        throw new TypeError('Full backup has no fixed cutoff');
      if (!state.ready) {
        // Capture-only mode: history writes would fail on the missing indexes.
        this.ctx.options.logger.warn(
          { guildId, jobId: job.jobId },
          'Archive full backup needs maintenance',
        );
        terminal = {
          cutoff,
          status: 'partial',
          issues: ['structural-maintenance-required'],
          reason: 'other',
        };
      } else {
        if (job.origin === undefined) {
          const origin: ArchiveRunOrigin = {
            bootId: this.ctx.bootId,
            gapVersion: state.continuity.gapVersion,
            breakIndex: state.continuity.breakIndex,
          };
          await state.repos.jobs.updateJob(job.jobId, { origin }, ARCHIVE_PROCESS_ID);
          job = { ...job, origin };
        }
        state.progress = new ProgressTracker({
          cutoff: new Date(cutoff),
          startedAt: job.resumedAt ?? job.startedAt ?? Date.now(),
          work: 'full-backup',
          jobId: job.jobId,
          runId,
          logger: this.ctx.options.logger,
        });
        await this.deps.inbox.drainInboxSafely(state);
        const { interruption, ...result } = await this.deps.scanner.scan(state, {
          runId,
          cutoff,
          mode: { kind: 'full-backup', jobId: job.jobId },
        });
        if (!this.shuttingDown(state)) {
          const status: ArchiveTerminalStatus =
            result.status === 'complete'
              ? 'complete'
              : interruption === 'cancelled'
                ? 'cancelled'
                : 'partial';
          terminal = {
            cutoff,
            status,
            counts: { ...result.counts },
            gaps: [...result.gaps],
            issues: [...result.issues],
            ...(status === 'partial'
              ? { reason: archiveGapReason(interruption ?? result.issues[0] ?? '') }
              : {}),
          };
          if (status === 'complete')
            await this.deps.continuity.settleCoverage(state, { full: true, origin: job.origin });
        }
      }
    } catch (error) {
      if (!this.shuttingDown(state)) {
        const stopped =
          error instanceof ArchiveJobStoppedError ||
          (await state.repos.jobs.getJob(job.jobId).catch(() => undefined))?.cancelRequested ===
            true;
        if (!stopped)
          this.ctx.options.logger.error(
            { guildId, jobId: job.jobId, err: error },
            'Archive full backup failed',
          );
        terminal = {
          cutoff,
          status: stopped ? 'cancelled' : 'failed',
          issues: [String(error)],
          ...(stopped ? {} : { reason: archiveGapReason(String(error)) }),
        };
        state.progress?.finish(stopped ? 'cancelled' : 'failed', String(error));
      }
    }
    await this.deps.progress.close(state);
    const progress = state.progress?.snapshot();
    if (terminal === undefined) {
      // Shutdown: keep the job running with its latest progress; the next boot queues it.
      if (progress !== undefined)
        await state.repos.jobs
          .saveJobProgress(job.jobId, ARCHIVE_PROCESS_ID, progress)
          .catch((error: unknown) => {
            this.ctx.options.logger.warn(
              { guildId, jobId: job.jobId, err: error },
              'Archive full backup progress not saved',
            );
          });
      return;
    }
    const finished: ArchiveFullBackupPatch = {
      status: terminal.status,
      result: { ...terminal, ...(progress === undefined ? {} : { progress }) },
      finishedAt: Date.now(),
    };
    if (await this.finishJob(state, guildId, job.jobId, finished))
      await this.afterFinish(state, guildId, job.jobId);
  }

  /** Prunes old records and shows the saved result on the backup's panel. */
  private async afterFinish(
    state: ArchiveGuildState,
    guildId: string,
    jobId: string,
  ): Promise<void> {
    await state.repos.jobs.pruneJobRecords(ARCHIVE_JOB_RECORDS_KEPT).catch((error: unknown) => {
      this.ctx.options.logger.warn({ guildId, err: error }, 'Archive job records not pruned');
    });
    const saved = await state.repos.jobs.getJob(jobId);
    if (saved !== undefined)
      await this.deps.notifications.publishBackupResult(guildId, state, saved);
  }

  /** Shutdown, unlike a stop request, is not the job's outcome. */
  private shuttingDown(state: ArchiveGuildState): boolean {
    return this.ctx.stopped || state.signal.signal.aborted;
  }

  /** Waits, ending early when the worker shuts down. */
  private async pause(state: ArchiveGuildState, ms: number): Promise<void> {
    const signal = state.signal.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Writes a job's terminal state with bounded retries. If every attempt
   * fails, the state is kept in memory and retried before any other work; after a
   * restart the job is queued again instead.
   */
  private async finishJob(
    state: ArchiveGuildState,
    guildId: string,
    jobId: string,
    terminal: ArchiveFullBackupPatch,
  ): Promise<boolean> {
    const base = this.ctx.options.terminalRetryBaseMs ?? TERMINAL_WRITE_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await state.repos.jobs.updateJob(jobId, terminal, ARCHIVE_PROCESS_ID, RELEASED_FIELDS);
        return true;
      } catch (error) {
        if (attempt >= TERMINAL_WRITE_ATTEMPTS || this.shuttingDown(state)) {
          this.ctx.options.logger.error(
            { guildId, jobId, attempts: attempt, err: error },
            'Archive job result could not be saved',
          );
          if (!this.shuttingDown(state))
            state.work.pendingFinish = {
              jobId,
              terminal,
              attempts: attempt,
              retryAt: Date.now() + deferredRetryDelay(0),
            };
          return false;
        }
        await this.pause(state, base * 2 ** (attempt - 1));
      }
    }
  }

  private async retryPendingFinish(state: ArchiveGuildState, guildId: string): Promise<void> {
    const pending = state.work.pendingFinish;
    if (pending === undefined || Date.now() < pending.retryAt) return;
    try {
      await state.repos.jobs.updateJob(
        pending.jobId,
        pending.terminal,
        ARCHIVE_PROCESS_ID,
        RELEASED_FIELDS,
      );
    } catch (error) {
      pending.attempts += 1;
      pending.retryAt = Date.now() + deferredRetryDelay(pending.attempts);
      this.ctx.options.logger.warn(
        { guildId, jobId: pending.jobId, attempts: pending.attempts, err: error },
        'Archive job result still not saved',
      );
      return;
    }
    state.work.pendingFinish = undefined;
    await this.afterFinish(state, guildId, pending.jobId);
  }
}
