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
