import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

interface PerformanceSnapshot {
  readonly version: 1;
  readonly scope: 'current-node-process';
  readonly elapsedMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly sampledPeakRssBytes: number;
  readonly sampledPeakHeapBytes: number;
  readonly memorySampleIntervalMs: number;
  readonly eventLoop: { readonly samples: number; readonly meanMs: number; readonly maxMs: number };
  readonly gc: { readonly count: number; readonly durationMs: number };
}

/** Process measurements exclude MongoDB and other bots; sampled peaks are lower bounds. */
export class ArchivePerformanceSampler {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly observer: PerformanceObserver;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | undefined;
  private initialCpu = { user: 0, system: 0 };
  private peakRss = 0;
  private peakHeap = 0;
  private gcCount = 0;
  private gcDuration = 0;
  private stopped: PerformanceSnapshot | undefined;

  constructor(private readonly sampleIntervalMs = 100) {
    if (
      !Number.isSafeInteger(sampleIntervalMs) ||
      sampleIntervalMs < 20 ||
      sampleIntervalMs > 2_147_483_647
    )
      throw new Error('invalid-performance-sample-interval');
    this.observer = new PerformanceObserver((list) => {
      this.collectGc(list.getEntries());
    });
  }

  start(): void {
    if (this.startedAt !== undefined) throw new Error('performance-sampler-already-started');
    this.startedAt = performance.now();
    this.initialCpu = process.cpuUsage();
    this.sampleMemory();
    this.delay.enable();
    this.observer.observe({ entryTypes: ['gc'] });
    this.timer = setInterval(() => this.sampleMemory(), this.sampleIntervalMs);
    this.timer.unref();
  }

  snapshot(): PerformanceSnapshot {
    if (this.stopped !== undefined) return structuredClone(this.stopped);
    if (this.startedAt === undefined) throw new Error('performance-sampler-not-started');
    this.sampleMemory();
    this.collectGc(this.observer.takeRecords());
    const cpu = process.cpuUsage(this.initialCpu);
    const samples = this.delay.count;
    return {
      version: 1,
      scope: 'current-node-process',
      elapsedMs: Math.max(0, performance.now() - this.startedAt),
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      sampledPeakRssBytes: this.peakRss,
      sampledPeakHeapBytes: this.peakHeap,
      memorySampleIntervalMs: this.sampleIntervalMs,
      eventLoop: {
        samples,
        meanMs: samples === 0 ? 0 : this.delay.mean / 1e6,
        maxMs: samples === 0 ? 0 : this.delay.max / 1e6,
      },
      gc: { count: this.gcCount, durationMs: this.gcDuration },
    };
  }

  stop(): PerformanceSnapshot {
    if (this.stopped !== undefined) return structuredClone(this.stopped);
    const snapshot = this.snapshot();
    clearInterval(this.timer);
    this.delay.disable();
    this.observer.disconnect();
    this.stopped = snapshot;
    return structuredClone(snapshot);
  }

  private sampleMemory(): void {
    const memory = process.memoryUsage();
    this.peakRss = Math.max(this.peakRss, memory.rss);
    this.peakHeap = Math.max(this.peakHeap, memory.heapUsed);
  }

  private collectGc(entries: readonly { duration: number }[]): void {
    for (const entry of entries) {
      this.gcCount += 1;
      this.gcDuration += entry.duration;
    }
  }
}
