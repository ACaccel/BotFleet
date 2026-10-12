import { ArchiveBackpressureError } from '../../../core/archive/errors';
import {
  ARCHIVE_LIMITS,
  archiveConcurrencySchema,
  archiveQueueLimit,
} from '../../../core/archive/limits';
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
  /** Defaults to the resource the request key names (see `resource`). */
  resource?: ArchiveResource;
}
interface SchedulerOptions {
  concurrency?: number;
  /** Defaults to `archiveQueueLimit` of the current concurrency. */
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
  resource?: ArchiveResource;
  queuedAt: number;
}
const weights: ArchivePriority[] = ['live', 'live', 'live', 'history', 'enrichment'];
/**
 * Discord REST routes the archive reads per channel. `@discordjs/rest` runs the
 * requests of one route and channel (one rate-limit handler) one after another, so
 * the scheduler admits at most one of them at a time, while different routes of
 * the same channel proceed in parallel. `discovery` covers the inventory routes.
 */
export type ArchiveRoute = 'messages' | 'message' | 'reactions' | 'channel' | 'discovery';
/**
 * What a request occupies while it runs: one route of a channel (its SDK major
 * parameter), or the whole resource when `route` is absent.
 */
export interface ArchiveResource {
  readonly channelId: string;
  readonly route?: ArchiveRoute;
}
const ROUTE_TEMPLATES: ReadonlyMap<string, ArchiveRoute> = new Map([
  ['/channels/:id/messages', 'messages'],
  ['/channels/:id/messages/:id', 'message'],
  ['/channels/:id/messages/:id/reactions/:reaction', 'reactions'],
  ['/channels/:id', 'channel'],
]);
/** The archive route of an SDK bucket route template, if the archive reads it. */
export const archiveRouteOf = (template: string | undefined): ArchiveRoute | undefined =>
  template === undefined ? undefined : ROUTE_TEMPLATES.get(template);
const sameResource = (left: ArchiveResource, right: ArchiveResource): boolean =>
  left.channelId === right.channelId && left.route === right.route;
/** A map key for a route of a channel. */
const routeKey = (route: ArchiveRoute, channelId: string): string => `${route}\u0000${channelId}`;

/** Admission only: Discord's shared SDK REST manager owns route/global waits and transport retries. */
export class ArchiveScheduler {
  private concurrency: number;
  private readonly queueLimit: number | undefined;
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
  /** Announced waits per route of a channel, and per whole channel (unknown routes). */
  private readonly routeWaits = new Map<string, number>();
  private readonly channelWaits = new Map<string, number>();
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
    this.queueLimit = options.maxQueued;
    this.validateConcurrency(this.concurrency);
    if (
      this.queueLimit !== undefined &&
      (!Number.isInteger(this.queueLimit) || this.queueLimit < 1)
    )
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
    const maxQueued = this.queueLimit ?? archiveQueueLimit(this.concurrency);
    if (this.queue.length >= maxQueued + (priority === 'live' ? 1 : 0))
      return Promise.reject(new ArchiveBackpressureError('archive-read-queue-full'));
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
        resource: options.resource ?? this.resource(key),
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
      const waits = wait.route === undefined ? this.channelWaits : this.routeWaits;
      const key = wait.route === undefined ? wait.channelId : routeKey(wait.route, wait.channelId);
      waits.set(key, Math.max(waits.get(key) ?? 0, wait.deadlineAt));
      if (waits.size > 128) waits.delete(waits.keys().next().value!);
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
      waitingResources: this.routeWaits.size + this.channelWaits.size,
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
          (work.resource === undefined ||
            ![...this.running].some(
              (active) =>
                active.resource !== undefined && sameResource(active.resource, work.resource!),
            )) &&
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
    const deadlines = [...this.routeWaits.values(), ...this.channelWaits.values()].filter(
      (deadline) => deadline > Date.now(),
    );
    if (this.queue.length > 0 && deadlines.length > 0) this.scheduleWake(Math.min(...deadlines));
  }

  /** The resource a request key names: `history`, `reaction` and `discovery` keys carry their channel. */
  private resource(key: string): ArchiveResource | undefined {
    const [kind, id, detail] = key.split(':');
    if (id === undefined) return undefined;
    switch (kind) {
      case 'history':
        return { route: 'messages', channelId: id };
      case 'reaction':
        return { route: 'reactions', channelId: id };
      case 'discovery':
        return id === 'known' && detail !== undefined
          ? { route: 'channel', channelId: detail }
          : { route: 'discovery', channelId: id };
      default:
        return undefined;
    }
  }
  /** A wait announced for the request's route, or for its whole channel, holds it back. */
  private waiting(work: Work): boolean {
    const resource = work.resource;
    if (resource === undefined) return false;
    const now = Date.now();
    return (
      (resource.route !== undefined &&
        (this.routeWaits.get(routeKey(resource.route, resource.channelId)) ?? 0) > now) ||
      (this.channelWaits.get(resource.channelId) ?? 0) > now
    );
  }
  private pruneWaits(): void {
    for (const waits of [this.routeWaits, this.channelWaits])
      for (const [key, until] of waits) if (until <= Date.now()) waits.delete(key);
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
