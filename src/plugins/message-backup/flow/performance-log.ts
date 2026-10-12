import type { PipelineSnapshot } from './pipeline';
import type { RestTelemetrySnapshot } from './rest-telemetry';
import type { ArchiveScheduler } from './scheduler';

type SchedulerSnapshot = ReturnType<ArchiveScheduler['snapshot']>;

export interface ArchivePerformanceLog {
  readonly pipeline: Omit<PipelineSnapshot, 'stages'>;
  readonly stages: PipelineSnapshot['stages'];
  readonly scheduler: {
    readonly active: number;
    readonly queued: number;
    readonly background: number;
    readonly waitingResources: number;
    readonly globalWait: boolean;
    /** Present while invalid requests throttle background reads (see `ARCHIVE_INVALID_REQUESTS`). */
    readonly backgroundLimit?: number;
  };
  /** 429 responses by Discord scope (`user` is the per-route limit) and SDK queue-delay waits. */
  readonly rateLimits: {
    readonly responses: number;
    readonly global429: number;
    readonly route429: number;
    readonly shared429: number;
    readonly unknown429: number;
    readonly waitEvents: number;
    readonly waitMs: number;
    readonly globalWaitMs: number;
    readonly routeWaitMs: number;
    readonly invalidLast10Minutes: number;
  };
}

/**
 * The cumulative owner diagnostics of `Archive pipeline performance`.
 *
 * The logger's scrubber replaces every value four levels below the log root, so no
 * number may sit deeper than three levels (`stages.fetch.count`). Raw telemetry keeps
 * its own nesting; this view flattens it instead of weakening the scrubber.
 */
export const archivePerformanceLog = (
  pipeline: PipelineSnapshot,
  rest: RestTelemetrySnapshot,
  scheduler: SchedulerSnapshot,
): ArchivePerformanceLog => {
  const { stages, ...budget } = pipeline;
  return {
    pipeline: budget,
    stages,
    scheduler: {
      active: scheduler.active,
      queued: scheduler.queued,
      background: scheduler.background,
      waitingResources: scheduler.waitingResources,
      globalWait: scheduler.globalWaitUntil !== undefined,
      ...(scheduler.backgroundLimit === undefined
        ? {}
        : { backgroundLimit: scheduler.backgroundLimit }),
    },
    rateLimits: {
      responses: rest.responses,
      global429: rest.actual429.global,
      route429: rest.actual429.user,
      shared429: rest.actual429.shared,
      unknown429: rest.actual429.unknown,
      waitEvents: rest.sdkWaitEvents,
      waitMs: rest.announcedWaitMs,
      globalWaitMs: rest.announcedGlobalWaitMs,
      routeWaitMs: rest.announcedLocalWaitMs,
      invalidLast10Minutes: rest.invalidResponsesLast10Minutes,
    },
  };
};

/** Counters of one archive serial writer (see `ArchiveSerialWriter.snapshot`). */
export interface ArchiveWriterCounters {
  readonly pending: number;
  readonly peakPending: number;
  readonly completed: number;
  readonly failed: number;
  readonly queueWaitMs: number;
  readonly operationMs: number;
  readonly drainMs: number;
}
type Prefixed<P extends string> = {
  readonly [K in keyof ArchiveWriterCounters as `${P}${Capitalize<K>}`]: number;
};
export type ArchiveWriterPerformanceLog = { readonly guildId: string } & Prefixed<'writer'> &
  Prefixed<'inboxWriter'>;

const prefixed = <P extends string>(prefix: P, counters: ArchiveWriterCounters): Prefixed<P> =>
  Object.fromEntries(
    Object.entries(counters).map(([key, value]) => [
      `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  ) as Prefixed<P>;

/**
 * One guild's writer counters in `Archive worker performance`, flattened
 * (`writers[0].writerPending`, `writers[0].inboxWriterPending`) so they stay above
 * the logger scrubber's depth limit.
 */
export const archiveWriterPerformanceLog = (
  guildId: string,
  writer: ArchiveWriterCounters,
  inboxWriter: ArchiveWriterCounters,
): ArchiveWriterPerformanceLog => ({
  guildId,
  ...prefixed('writer', writer),
  ...prefixed('inboxWriter', inboxWriter),
});
