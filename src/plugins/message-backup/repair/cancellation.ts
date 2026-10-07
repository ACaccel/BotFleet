import { performance } from 'node:perf_hooks';

export class ArchiveRepairCancelledError extends Error {
  constructor() {
    super('Archive job cancelled');
    this.name = 'ArchiveRepairCancelledError';
  }
}

/** A single execution owns its cancellation observation and pending lookup. */
export class ArchiveRepairCancellation {
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
    if (this.cancelled || this.signal?.aborted) throw new ArchiveRepairCancelledError();
    const age = this.now() - this.checkedAt;
    if (this.pending === undefined && age >= 0 && age < 250) return;
    this.pending ??= this.refresh();
    await this.wait(this.pending);
    if (this.cancelled || this.signal?.aborted) throw new ArchiveRepairCancelledError();
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
    if (signal.aborted) throw new ArchiveRepairCancelledError();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ArchiveRepairCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
