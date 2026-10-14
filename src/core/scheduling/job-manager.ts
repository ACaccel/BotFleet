import type { Job } from 'node-schedule';
import schedule from 'node-schedule';

import type { Logger } from '../logger';

/**
 * Keyed wrapper around `node-schedule` that owns the lifecycle of a set
 * of scheduled jobs.
 *
 * The job `Map` is supplied by the caller so the plugin can keep its own
 * persistent job registry; `JobManager` is a thin stateless view over it.
 *
 * Failure policy: `node-schedule` discards whatever its callback
 * returns, so a rejected async job would surface only as a process-wide
 * `unhandledRejection` — detached from the job that caused it. Both
 * scheduling methods therefore wrap the callback and route a rejection
 * (or a synchronous throw) to the injected {@link Logger}, tagged with
 * the job key.
 */
export class JobManager {
  /**
   * @param jobs   Caller-owned registry of live jobs, keyed by job key.
   * @param logger Sink for callback failures. Optional so existing
   *   call sites compile, but a manager without one silently drops
   *   every job failure — pass the owner's logger.
   */
  constructor(
    private readonly jobs: Map<string, Job>,
    private readonly logger?: Logger,
  ) {}

  /**
   * Schedule a job to run at the specified time and store it in the map
   * under `key`, replacing any previously stored job for that key.
   */
  schedule(key: string, date: Date, callback: () => void | Promise<unknown>): Job {
    const job = schedule.scheduleJob(date, this.guard(key, callback));
    this.jobs.set(key, job);
    return job;
  }

  /**
   * Schedule a recurring job from a cron expression and store it under
   * `key`, replacing any previously stored job. Unlike {@link schedule}
   * (a one-shot at a fixed `Date`), the returned `node-schedule` job
   * re-fires on every cron match until cancelled — used for low-frequency
   * maintenance loops such as the weekly default-model refresh.
   */
  scheduleRecurring(key: string, cron: string, callback: () => void | Promise<unknown>): Job {
    const job = schedule.scheduleJob(cron, this.guard(key, callback));
    this.jobs.set(key, job);
    return job;
  }

  /**
   * Wrap `callback` so neither a synchronous throw nor a rejected
   * promise escapes into the scheduler.
   */
  private guard(key: string, callback: () => void | Promise<unknown>): () => void {
    return () => {
      try {
        const result = callback();
        if (result instanceof Promise) {
          void result.catch((err: unknown) => {
            this.report(key, err);
          });
        }
      } catch (err: unknown) {
        this.report(key, err);
      }
    };
  }

  private report(key: string, err: unknown): void {
    this.logger?.error(
      { err: err instanceof Error ? err : new Error(String(err)), job: key },
      'scheduled job failed',
    );
  }

  /**
   * Cancel a job by its key and remove it from the map.
   *
   * @returns `true` if a job existed for `key` and was cancelled.
   */
  cancel(key: string): boolean {
    const job = this.jobs.get(key);
    if (job) {
      job.cancel();
      this.jobs.delete(key);
      return true;
    }
    return false;
  }

  /** Look up the job currently registered under `key`, if any. */
  get(key: string): Job | undefined {
    return this.jobs.get(key);
  }

  /** Report whether a job is registered under `key`. */
  has(key: string): boolean {
    return this.jobs.has(key);
  }
}
