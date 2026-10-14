import type { ArchiveFullBackupPatch } from '../../../persistence/repositories/archive-job.repo';

/** A full backup's terminal state whose write failed every attempt. */
export interface ArchivePendingFinish {
  jobId: string;
  terminal: ArchiveFullBackupPatch;
  attempts: number;
  retryAt: number;
}

/**
 * One guild's history work slot: a periodic pass or a full backup, never both.
 *
 * Pattern: Mediator — the periodic and job runners never inspect each other; a
 * queued backup preempts a periodic pass at a safe boundary through this slot, and
 * periodic passes wait while backup work, or its unsaved result, holds it.
 */
export class ArchiveWorkSlot {
  private working: 'job' | 'periodic' | undefined;
  /** A job poll is preparing to run a full backup; periodic passes do not start. */
  private jobPending = false;
  private periodicAbort: AbortController | undefined;
  private periodicWork: Promise<unknown> | undefined;
  private jobWork: Promise<void> | undefined;
  /**
   * Retried before any other job work; periodic passes stay paused meanwhile. Only
   * the job runner writes it.
   */
  public pendingFinish: ArchivePendingFinish | undefined;

  /** Full-backup work, including an unsaved result, keeps periodic passes paused. */
  public periodicBlocked(): boolean {
    return this.working !== undefined || this.jobPending || this.pendingFinish !== undefined;
  }

  /** Whether a periodic pass holds the slot. */
  public get periodicActive(): boolean {
    return this.periodicWork !== undefined;
  }

  /** Aborted when a queued backup preempts the running periodic pass. */
  public get periodicSignal(): AbortSignal | undefined {
    return this.periodicAbort?.signal;
  }

  /** Whether the running periodic pass was preempted. */
  public periodicPreempted(): boolean {
    return this.periodicAbort?.signal.aborted === true;
  }

  /** Asks the running periodic pass, if any, to stop at its next boundary. */
  public preemptPeriodic(): void {
    this.periodicAbort?.abort();
  }

  /**
   * Starts a periodic pass unless the slot is held; `settle` runs before the slot
   * is released, whatever the outcome.
   */
  public startPeriodic<T>(
    run: () => Promise<T>,
    settle: () => Promise<void>,
  ): Promise<T> | undefined {
    if (this.periodicBlocked()) return undefined;
    this.working = 'periodic';
    this.periodicAbort = new AbortController();
    const work = (async () => {
      try {
        return await run();
      } finally {
        await settle();
        this.periodicWork = undefined;
        this.periodicAbort = undefined;
        this.working = undefined;
      }
    })();
    this.periodicWork = work;
    return work;
  }

  /** Concurrent job polls share one run. */
  public async joinJobPoll(run: () => Promise<void>): Promise<void> {
    if (this.jobWork !== undefined) return this.jobWork;
    const work = run();
    this.jobWork = work;
    try {
      await work;
    } finally {
      if (this.jobWork === work) this.jobWork = undefined;
    }
  }

  /**
   * Runs job work in the slot. A running periodic pass is preempted only when
   * `shouldPreempt` holds; the job then waits for the pass to end and for
   * `afterPreempt` before it starts.
   */
  public async runJob(
    shouldPreempt: () => Promise<boolean>,
    afterPreempt: () => Promise<void>,
    work: () => Promise<void>,
  ): Promise<void> {
    if (this.working === 'job') return;
    // No periodic pass may start while this poll prepares to run a backup.
    this.jobPending = true;
    try {
      if (this.working === 'periodic') {
        if (!(await shouldPreempt())) return;
        this.preemptPeriodic();
        await this.periodicWork;
        await afterPreempt();
      }
      this.working = 'job';
      try {
        await work();
      } finally {
        this.working = undefined;
      }
    } finally {
      this.jobPending = false;
    }
  }

  /** Work shutdown waits for. */
  public pending(): Promise<unknown>[] {
    return [this.periodicWork, this.jobWork].filter(
      (work): work is Promise<unknown> => work !== undefined,
    );
  }
}
