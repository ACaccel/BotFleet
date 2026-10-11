import { performance } from 'node:perf_hooks';

/** A stop was requested for the running job, or the worker is shutting down. */
export class ArchiveJobStoppedError extends Error {
  constructor() {
    super('Archive job stop requested');
    this.name = 'ArchiveJobStoppedError';
  }
}

/**
 * Polls a job's stop request at scan boundaries, at most once per 250 ms. A single
 * execution owns its observation and pending lookup.
 */
export class ArchiveJobCancellation {
  private checkedAt = Number.NEGATIVE_INFINITY;
  private cancelled = false;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly jobId: string,
    private readonly lookup: (jobId: string) => Promise<boolean>,
    private readonly signal?: AbortSignal,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async checkpoint(): Promise<void> {
    if (this.cancelled || this.signal?.aborted) throw new ArchiveJobStoppedError();
    const age = this.now() - this.checkedAt;
    if (this.pending === undefined && age >= 0 && age < 250) return;
    this.pending ??= this.refresh();
    await this.wait(this.pending);
    if (this.cancelled || this.signal?.aborted) throw new ArchiveJobStoppedError();
  }

  isCancelled(): boolean {
    return this.cancelled || this.signal?.aborted === true;
  }

  private async refresh(): Promise<void> {
    // Freshness starts when the query is issued, rather than when it returns.
    const checkedAt = this.now();
    try {
      this.cancelled = await Promise.resolve().then(() => this.lookup(this.jobId));
      this.checkedAt = checkedAt;
    } finally {
      this.pending = undefined;
    }
  }

  private async wait(pending: Promise<void>): Promise<void> {
    const signal = this.signal;
    if (signal === undefined) return pending;
    if (signal.aborted) throw new ArchiveJobStoppedError();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ArchiveJobStoppedError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
