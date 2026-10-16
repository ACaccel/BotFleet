/**
 * Concurrency limit for page downloads with two priorities.
 *
 * A page someone is waiting for (`foreground`) always starts before queued
 * prefetches, and a queued prefetch can be promoted when a reader reaches
 * that page first. The prefetch queue is bounded: once full, new prefetches
 * are declined rather than queued, so a burst of page turns across many
 * galleries cannot build an unbounded backlog of speculative downloads.
 */
type Priority = 'foreground' | 'prefetch';

interface Queued {
  readonly key: string;
  readonly start: () => void;
}

export class DownloadLimiter {
  private active = 0;
  private readonly foreground: Queued[] = [];
  private readonly prefetch: Queued[] = [];

  public constructor(
    private readonly concurrency: number,
    private readonly maxQueuedPrefetches: number,
  ) {}

  /**
   * Run `task` under the limit. Resolves `undefined` without running it when
   * a prefetch finds the queue full.
   */
  public run<T>(key: string, priority: Priority, task: () => Promise<T>): Promise<T | undefined> {
    if (priority === 'prefetch' && !this.acceptsPrefetch()) {
      return Promise.resolve(undefined);
    }
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.next();
          });
      };
      if (this.active < this.concurrency) start();
      else (priority === 'foreground' ? this.foreground : this.prefetch).push({ key, start });
    });
  }

  /** Whether a prefetch submitted now would be accepted. */
  public acceptsPrefetch(): boolean {
    return this.active < this.concurrency || this.prefetch.length < this.maxQueuedPrefetches;
  }

  /** Move a still-queued prefetch for `key` ahead of every other prefetch. */
  public promote(key: string): void {
    const index = this.prefetch.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    const [entry] = this.prefetch.splice(index, 1);
    if (entry !== undefined) this.foreground.push(entry);
  }

  private next(): void {
    const entry = this.foreground.shift() ?? this.prefetch.shift();
    entry?.start();
  }
}
