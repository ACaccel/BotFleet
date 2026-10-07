import { createHash } from 'node:crypto';
import type { APIRequest, RateLimitData, ResponseLike, REST } from 'discord.js';

interface RestTelemetrySnapshot {
  observedAt: number;
  responses: number;
  statuses: Record<string, number>;
  actual429: { global: number; shared: number; user: number; unknown: number };
  sdkWaitEvents: number;
  announcedWaitMs: number;
  announcedGlobalWaitMs: number;
  announcedLocalWaitMs: number;
  observerFailures: number;
  invalidResponsesLast10Minutes: number;
  ipScope: 'this-rest-manager-only';
  bucketWaits: { key: string; events: number; announcedWaitMs: number }[];
}

export interface ArchiveRestWait {
  readonly resourceId: string;
  readonly bucketKey: string;
  readonly global: boolean;
  readonly deadlineAt: number;
}

/** Observe the existing SDK owner without retaining routes, token headers or response bodies. */
export class ArchiveRestTelemetry {
  private rest: REST | undefined;
  private responses = 0;
  private readonly statuses: Record<string, number> = {};
  private readonly actual429 = { global: 0, shared: 0, user: 0, unknown: 0 };
  private sdkWaitEvents = 0;
  private announcedWaitMs = 0;
  private announcedGlobalWaitMs = 0;
  private announcedLocalWaitMs = 0;
  private observerFailures = 0;
  private readonly invalidSeconds = new Map<number, number>();
  private readonly buckets = new Map<string, { events: number; announcedWaitMs: number }>();
  private readonly responseListener = (_request: APIRequest, response: ResponseLike): void => {
    this.response(
      response.status,
      response.headers.get('x-ratelimit-scope'),
      response.headers.get('x-ratelimit-global'),
    );
  };
  private readonly waitListener = (info: RateLimitData): void => {
    this.wait(info);
  };

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly onWait?: (wait: ArchiveRestWait) => void,
  ) {}

  attach(rest: REST): void {
    if (this.rest === rest) return;
    if (this.rest !== undefined) throw new Error('archive-rest-observer-already-attached');
    this.rest = rest;
    rest.on('response', this.responseListener);
    rest.on('rateLimited', this.waitListener);
  }
  detach(): void {
    this.rest?.off('response', this.responseListener);
    this.rest?.off('rateLimited', this.waitListener);
    this.rest = undefined;
  }

  /** Queue-delay events do not imply another HTTP attempt or 429 response. */
  wait(
    info: Pick<
      RateLimitData,
      'hash' | 'majorParameter' | 'retryAfter' | 'timeToReset' | 'sublimitTimeout'
    > &
      Partial<Pick<RateLimitData, 'global' | 'scope'>>,
  ): void {
    const delay = Math.max(
      0,
      ...[info.retryAfter, info.timeToReset, info.sublimitTimeout].filter(Number.isFinite),
    );
    this.sdkWaitEvents += 1;
    this.announcedWaitMs += delay;
    const global = info.global === true || info.scope === 'global';
    if (global) this.announcedGlobalWaitMs += delay;
    else this.announcedLocalWaitMs += delay;
    const key = createHash('sha256')
      .update(`${info.hash}:${info.majorParameter}`)
      .digest('hex')
      .slice(0, 16);
    const bucket = this.buckets.get(key) ?? { events: 0, announcedWaitMs: 0 };
    bucket.events += 1;
    bucket.announcedWaitMs += delay;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > 128) this.buckets.delete(this.buckets.keys().next().value!);
    try {
      this.onWait?.({
        resourceId: info.majorParameter,
        bucketKey: key,
        global,
        deadlineAt: this.clock() + delay,
      });
    } catch {
      // Diagnostic consumers must not interrupt the shared SDK transport.
      this.observerFailures += 1;
    }
  }
  response(status: number, scope: string | null, global: string | null = null): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    this.responses += 1;
    this.statuses[String(status)] = (this.statuses[String(status)] ?? 0) + 1;
    if (status === 429) {
      const classification =
        global === 'true' || scope === 'global'
          ? 'global'
          : scope === 'shared'
            ? 'shared'
            : scope === 'user'
              ? 'user'
              : 'unknown';
      this.actual429[classification] += 1;
    }
    this.prune();
    if (status === 401 || status === 403 || (status === 429 && scope !== 'shared')) {
      const second = Math.floor(this.clock() / 1000);
      this.invalidSeconds.set(second, (this.invalidSeconds.get(second) ?? 0) + 1);
    }
  }
  snapshot(): RestTelemetrySnapshot {
    this.prune();
    return {
      observedAt: this.clock(),
      responses: this.responses,
      statuses: { ...this.statuses },
      actual429: { ...this.actual429 },
      sdkWaitEvents: this.sdkWaitEvents,
      announcedWaitMs: this.announcedWaitMs,
      announcedGlobalWaitMs: this.announcedGlobalWaitMs,
      announcedLocalWaitMs: this.announcedLocalWaitMs,
      observerFailures: this.observerFailures,
      invalidResponsesLast10Minutes: [...this.invalidSeconds.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      ipScope: 'this-rest-manager-only',
      bucketWaits: [...this.buckets].map(([key, value]) => ({ key, ...value })),
    };
  }
  private prune(): void {
    const oldest = Math.floor(this.clock() / 1000) - 600;
    for (const second of this.invalidSeconds.keys())
      if (second < oldest) this.invalidSeconds.delete(second);
  }
}
