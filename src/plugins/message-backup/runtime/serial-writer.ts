import { performance } from 'node:perf_hooks';

interface WriterSnapshot {
  pending: number;
  peakPending: number;
  completed: number;
  failed: number;
  queueWaitMs: number;
  operationMs: number;
  drainMs: number;
}

/** Serializes archive mutations while capture continues durably in its inbox. */
export class ArchiveSerialWriter {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private readonly metrics = {
    peakPending: 0,
    completed: 0,
    failed: 0,
    queueWaitMs: 0,
    operationMs: 0,
    drainMs: 0,
  };
  public constructor(private readonly limit = 1000) {}
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('Archive writer is draining');
    if (this.pending >= this.limit) throw new Error('Archive writer queue is full');
    this.pending += 1;
    this.metrics.peakPending = Math.max(this.metrics.peakPending, this.pending);
    const queuedAt = performance.now();
    const result = this.tail.then(async () => {
      const startedAt = performance.now();
      this.metrics.queueWaitMs += Math.max(0, startedAt - queuedAt);
      try {
        const value = await operation();
        this.metrics.completed += 1;
        return value;
      } catch (error) {
        this.metrics.failed += 1;
        throw error;
      } finally {
        this.metrics.operationMs += Math.max(0, performance.now() - startedAt);
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.pending -= 1;
    }
  }
  public async drain(): Promise<void> {
    const startedAt = performance.now();
    await this.tail;
    this.metrics.drainMs += Math.max(0, performance.now() - startedAt);
  }
  public async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }
  public snapshot(): WriterSnapshot {
    return { pending: this.pending, ...this.metrics };
  }
}
