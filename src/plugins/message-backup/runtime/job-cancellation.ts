import { performance } from 'node:perf_hooks';
import type { Logger } from '../../../core/logger';
import { isProgrammerError } from './worker-context';

/** A stop was requested for the running job, or the worker is shutting down. */
export class ArchiveJobStoppedError extends Error {
  constructor() {
    super('Archive job stop requested');
    this.name = 'ArchiveJobStoppedError';
  }
}

/** Minimum interval between two logs of failed stop lookups. */
const LOOKUP_FAILURE_LOG_MS = 60_000;

interface ArchiveJobCancellationOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly logger?: Pick<Logger, 'warn'>;
}

/**
 * Polls a job's stop request at scan boundaries, at most once per 250 ms. A single
 * execution owns its observation and pending lookup. A failed lookup is not a stop
 * request and must not fail the sources waiting on it: the boundary passes, the
 * failure is logged at most once a minute, and the next boundary at least 250 ms
 * later asks again. A programmer error in the lookup still fails the boundary.
 */
export class ArchiveJobCancellation {
  private checkedAt = Number.NEGATIVE_INFINITY;
  private cancelled = false;
  private pending: Promise<void> | undefined;
  private failedLookups = 0;
  private failureLoggedAt = Number.NEGATIVE_INFINITY;
  private readonly signal: AbortSignal | undefined;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'warn'> | undefined;

  constructor(
    private readonly jobId: string,
    private readonly lookup: (jobId: string) => Promise<boolean>,
    options: ArchiveJobCancellationOptions = {},
  ) {
    this.signal = options.signal;
    this.now = options.now ?? (() => performance.now());
    this.logger = options.logger;
  }

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
      this.failedLookups = 0;
    } catch (error) {
      // A defect in the lookup is not an outage; it fails the boundary.
      if (isProgrammerError(error)) throw error;
      // The throttle still applies, so a failing database is asked at most every 250 ms.
      this.checkedAt = checkedAt;
      this.failedLookups += 1;
      const now = this.now();
      if (now - this.failureLoggedAt >= LOOKUP_FAILURE_LOG_MS || now < this.failureLoggedAt) {
        this.failureLoggedAt = now;
        this.logger?.warn(
          { jobId: this.jobId, failedLookups: this.failedLookups, err: error },
          'Archive job stop lookup failed; continuing until the next boundary',
        );
      }
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
