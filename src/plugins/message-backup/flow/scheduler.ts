import { ARCHIVE_LIMITS, archiveConcurrencySchema } from '../../../core/archive/limits';
import type { ArchiveRestWait } from './rest-telemetry';

type ArchivePriority = 'live' | 'history' | 'enrichment';
interface AdmissionMetric {
  completed: number;
  failed: number;
  admissionWaitMs: number;
  operationMs: number;
}
interface ScheduleOptions {
  signal?: AbortSignal;
  generation?: string;
  guildId?: string;
  resourceId?: string;
}
interface SchedulerOptions {
  concurrency?: number;
  maxQueued?: number;
}
interface Work {
  key: string;
  priority: ArchivePriority;
  operation: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  cancel?: () => void;
  guildId: string;
  resourceId?: string;
  queuedAt: number;
}
const weights: ArchivePriority[] = ['live', 'live', 'live', 'history', 'enrichment'];

/** Admission only: Discord's shared SDK REST manager owns route/global waits and transport retries. */
export class ArchiveScheduler {
  private concurrency: number;
  private readonly maxQueued: number;
  private readonly queue: Work[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly cancellationScopes = new WeakMap<AbortSignal, number>();
  private nextScope = 0;
  private active = 0;
  private background = 0;
  private turn = 0;
  private paused = false;
  private stopped: Error | undefined;
  private readonly running = new Set<Work>();
  private readonly lastGuild = new Map<ArchivePriority, string>();
  private readonly resourceWaits = new Map<string, number>();
  private globalWaitUntil = 0;
  private wake: ReturnType<typeof setTimeout> | undefined;
  private readonly metrics: Record<
    ArchivePriority,
    { completed: number; failed: number; admissionWaitMs: number; operationMs: number }
  > = {
    live: { completed: 0, failed: 0, admissionWaitMs: 0, operationMs: 0 },
    history: { completed: 0, failed: 0, admissionWaitMs: 0, operationMs: 0 },
    enrichment: { completed: 0, failed: 0, admissionWaitMs: 0, operationMs: 0 },
  };

  constructor(options: SchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? ARCHIVE_LIMITS.concurrency.default;
    this.maxQueued = options.maxQueued ?? 128;
    this.validateConcurrency(this.concurrency);
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 1)
      throw new Error('invalid-archive-queue-limit');
  }

  run<T>(
    key: string,
    priority: ArchivePriority,
    operation: () => Promise<T>,
    options: ScheduleOptions = {},
  ): Promise<T> {
    if (this.stopped !== undefined) return Promise.reject(this.stopped);
    if (options.signal?.aborted === true)
      return Promise.reject(new Error('archive-read-cancelled'));
    let scope = 0;
    if (options.signal !== undefined) {
      scope = this.cancellationScopes.get(options.signal) ?? ++this.nextScope;
      this.cancellationScopes.set(options.signal, scope);
    }
    const identity = JSON.stringify([key, options.generation ?? '', scope]);
    // Only consumers with the same cancellation authority share an in-flight page.
    const shared = this.pending.get(identity);
    if (shared !== undefined) return shared as Promise<T>;
    if (this.queue.length >= this.maxQueued + (priority === 'live' ? 1 : 0))
      return Promise.reject(new Error('archive-read-queue-full'));
    let work: Work;
    const result = new Promise<T>((resolve, reject) => {
      work = {
        key: identity,
        priority,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        signal: options.signal,
        guildId: options.guildId ?? 'unspecified',
        resourceId: options.resourceId ?? this.resource(key),
        queuedAt: Date.now(),
      };
      if (options.signal !== undefined) {
        work.cancel = () => {
          const index = this.queue.indexOf(work);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(new Error('archive-read-cancelled'));
            this.pump();
          }
        };
        options.signal.addEventListener('abort', work.cancel, { once: true });
      }
      this.queue.push(work);
    });
    if (!this.pending.has(identity)) {
      this.pending.set(identity, result);
    }
    void result
      .finally(() => {
        if (this.pending.get(identity) === result) {
          this.pending.delete(identity);
        }
        if (work.cancel !== undefined) work.signal?.removeEventListener('abort', work.cancel);
      })
      .catch(() => undefined);
    this.pump();
    return result;
  }

  pauseBackground(): void {
    this.paused = true;
  }
  resumeBackground(): void {
    this.paused = false;
    this.pump();
  }
  setConcurrency(value: number): void {
    this.validateConcurrency(value);
    this.concurrency = value;
    this.pump();
  }
  stop(reason = new Error('archive-rest-owner-stopped')): void {
    this.stopped = reason;
    for (const work of this.queue.splice(0)) work.reject(reason);
    clearTimeout(this.wake);
  }
  /** Public SDK wait events guide admission; transport release/retry stays under SDK ownership. */
  observeWait(wait: ArchiveRestWait): void {
    if (!Number.isFinite(wait.deadlineAt) || wait.deadlineAt <= Date.now()) return;
    if (wait.global) this.globalWaitUntil = Math.max(this.globalWaitUntil, wait.deadlineAt);
    else {
      this.resourceWaits.set(
        wait.resourceId,
        Math.max(this.resourceWaits.get(wait.resourceId) ?? 0, wait.deadlineAt),
      );
      if (this.resourceWaits.size > 128)
        this.resourceWaits.delete(this.resourceWaits.keys().next().value!);
    }
    this.pump();
  }
  snapshot(): {
    active: number;
    queued: number;
    background: number;
    paused: boolean;
    waitingResources: number;
    globalWaitUntil?: number;
    metrics: Readonly<Record<ArchivePriority, AdmissionMetric>>;
  } {
    this.pruneWaits();
    return {
      active: this.active,
      queued: this.queue.length,
      background: this.background,
      paused: this.paused,
      waitingResources: this.resourceWaits.size,
      ...(this.globalWaitUntil > Date.now() ? { globalWaitUntil: this.globalWaitUntil } : {}),
      metrics: structuredClone(this.metrics),
    };
  }

  private validateConcurrency(value: number): void {
    if (!archiveConcurrencySchema.safeParse(value).success)
      throw new Error('invalid-archive-concurrency');
  }
  private pump(): void {
    clearTimeout(this.wake);
    if (this.stopped !== undefined) return;
    this.pruneWaits();
    if (this.globalWaitUntil > Date.now()) {
      this.scheduleWake(this.globalWaitUntil);
      return;
    }
    while (
      this.active < this.concurrency * 2 + 1 &&
      this.queue.length > 0 &&
      this.stopped === undefined
    ) {
      let index = -1;
      const readyActive = [...this.running].filter((work) => !this.waiting(work)).length;
      const readyBackground = [...this.running].filter(
        (work) => work.priority !== 'live' && !this.waiting(work),
      ).length;
      if (readyActive >= this.concurrency + 1) break;
      for (let attempt = 0; attempt < weights.length; attempt += 1) {
        const priority = weights[this.turn++ % weights.length]!;
        const eligible = (work: Work): boolean =>
          !this.waiting(work) &&
          (work.resourceId === undefined ||
            ![...this.running].some((active) => active.resourceId === work.resourceId)) &&
          work.signal?.aborted !== true &&
          (work.priority === 'live' || (!this.paused && readyBackground < this.concurrency));
        index = this.queue.findIndex(
          (work) =>
            work.priority === priority &&
            work.guildId !== this.lastGuild.get(priority) &&
            eligible(work),
        );
        if (index < 0)
          index = this.queue.findIndex((work) => work.priority === priority && eligible(work));
        if (index >= 0) break;
      }
      if (index < 0) break;
      const work = this.queue.splice(index, 1)[0]!;
      this.active += 1;
      if (work.priority !== 'live') this.background += 1;
      this.running.add(work);
      this.lastGuild.set(work.priority, work.guildId);
      const started = Date.now();
      this.metrics[work.priority].admissionWaitMs += Math.max(0, started - work.queuedAt);
      void Promise.resolve()
        .then(() => {
          if (work.signal?.aborted) throw new Error('archive-read-cancelled');
          return work.operation();
        })
        .then(
          (value) => {
            this.metrics[work.priority].completed += 1;
            work.resolve(value);
          },
          (error: unknown) => {
            this.metrics[work.priority].failed += 1;
            const status = (error as { status?: number } | null)?.status;
            if (status === 401) this.stop(new Error('archive-invalid-credentials'));
            work.reject(error);
          },
        )
        .finally(() => {
          this.active -= 1;
          this.running.delete(work);
          this.metrics[work.priority].operationMs += Math.max(0, Date.now() - started);
          if (work.priority !== 'live') this.background -= 1;
          this.pump();
        });
    }
    const deadlines = [...this.resourceWaits.values()].filter((deadline) => deadline > Date.now());
    if (this.queue.length > 0 && deadlines.length > 0) this.scheduleWake(Math.min(...deadlines));
  }

  private resource(key: string): string | undefined {
    const pieces = key.split(':');
    return ['history', 'reaction', 'attachment', 'discovery'].includes(pieces[0] ?? '')
      ? pieces[1] === 'known'
        ? pieces[2]
        : pieces[1]
      : undefined;
  }
  private waiting(work: Work): boolean {
    return (
      work.resourceId !== undefined && (this.resourceWaits.get(work.resourceId) ?? 0) > Date.now()
    );
  }
  private pruneWaits(): void {
    for (const [resource, until] of this.resourceWaits)
      if (until <= Date.now()) this.resourceWaits.delete(resource);
  }
  private scheduleWake(deadline: number): void {
    this.wake = setTimeout(
      () => this.pump(),
      Math.min(2_147_483_647, Math.max(1, deadline - Date.now())),
    );
    this.wake.unref();
  }
}

/** Independent channels run concurrently, while each worker retains sequential ownership of its cursor. */
export async function mapArchiveChannels<T, R>(
  values: readonly T[],
  worker: (value: T, index: number) => Promise<R>,
  concurrency: number = ARCHIVE_LIMITS.concurrency.default,
): Promise<R[]> {
  if (!archiveConcurrencySchema.safeParse(concurrency).success)
    throw new Error('invalid-archive-concurrency');
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]!, index);
      }
    }),
  );
  return results;
}
