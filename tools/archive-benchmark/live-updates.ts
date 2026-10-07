import { performance } from 'node:perf_hooks';

/** One in-flight synthetic edit avoids staging work while MongoDB is slow. */
export class LiveUpdateProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private attempts = 0;
  private completed = 0;
  private failed = false;
  private durationMs = 0;
  private maximumMs = 0;

  constructor(
    private readonly update: (sequence: number) => Promise<void>,
    private readonly intervalMs = 100,
    private readonly limit = 100,
  ) {}

  start(): void {
    if (this.timer !== undefined) throw new Error('Live update probe already started');
    this.timer = setInterval(() => {
      if (this.pending !== undefined || this.attempts >= this.limit || this.failed) return;
      this.attempts += 1;
      const startedAt = performance.now();
      this.pending = Promise.resolve()
        .then(() => this.update(this.attempts))
        .then(() => {
          this.completed += 1;
        })
        .catch(() => {
          this.failed = true;
        })
        .finally(() => {
          const elapsed = Math.max(0, performance.now() - startedAt);
          this.durationMs += elapsed;
          this.maximumMs = Math.max(this.maximumMs, elapsed);
          this.pending = undefined;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<{
    completed: number;
    failed: boolean;
    meanLatencyMs: number;
    maximumLatencyMs: number;
  }> {
    clearInterval(this.timer);
    await this.pending;
    return {
      completed: this.completed,
      failed: this.failed,
      meanLatencyMs: this.attempts === 0 ? 0 : this.durationMs / this.attempts,
      maximumLatencyMs: this.maximumMs,
    };
  }
}
