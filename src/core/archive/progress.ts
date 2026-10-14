import { z } from 'zod';
import { archiveJobCutoff, type ArchiveJob } from './types';

const archivePhases = ['discovery', 'history', 'reactions', 'verification'] as const;
export type ArchivePhase = (typeof archivePhases)[number];
export type ArchiveProgressState = ArchiveJob['status'] | 'paused' | 'waiting' | 'cancelling';
export type ArchiveProgressUnit = 'messages' | 'documents' | 'operations' | 'channels' | 'checks';
export type ArchiveDenominatorQuality = 'exact' | 'discovered' | 'estimated' | 'unknown';
export type ArchiveActivityStep =
  | 'fetching'
  | 'processing'
  | 'writing'
  | 'reactions'
  | 'checkpoint'
  | 'waiting'
  | 'queued'
  | 'draining';
export type ArchiveGapReason = 'permission' | 'discovery' | 'capacity' | 'conflict' | 'other';
export interface ArchivePhaseProgress {
  committed: number;
  scanned: number;
  admitted: number;
  total?: number;
  referenceTotal?: number;
  quality: ArchiveDenominatorQuality;
  unit: ArchiveProgressUnit;
  rates?: number[];
}
export interface ArchiveActivity {
  sourceId: string;
  name: string;
  step: ArchiveActivityStep;
  scanned: number;
  pageProcessed?: number;
  pageTotal?: number;
  /** Staged membership entries for the current message; not distinct people or completed generations. */
  reactionUsers?: number;
  reactionPages?: number;
  provisional?: boolean;
  updatedAt: number;
  startedAt: number;
  direction?: 'before';
  cursor?: string;
  waitSince?: number;
  retryAt?: number;
}
export interface ArchiveScopeGap {
  sourceId?: string;
  name?: string;
  reason: ArchiveGapReason;
}
interface ArchiveRemainingEstimate {
  lowerMs: number;
  upperMs: number;
  scope: 'phase' | 'run';
  phase?: ArchivePhase;
  confidence: 'low' | 'medium';
  reason: string;
}
export interface ArchiveProgressSnapshot {
  version: 2;
  work: ArchiveJob['command'];
  jobId?: string;
  runId?: string;
  scanId?: string;
  cutoff: string;
  cutoffKnown?: boolean;
  startedAt: number;
  phase: ArchivePhase;
  substep: string;
  state: ArchiveProgressState;
  reason?: ArchiveGapReason;
  phases: Record<ArchivePhase, ArchivePhaseProgress>;
  elapsedMs: number;
  activeMs: number;
  pausedMs: number;
  updatedAt: number;
  lastProgressAt: number;
  lastCheckpointAt?: number;
  estimatedAt: number;
  estimate?: ArchiveRemainingEstimate;
  phaseEstimate?: ArchiveRemainingEstimate;
  estimating: boolean;
  activities: ArchiveActivity[];
  activityCount: number;
  gaps: ArchiveScopeGap[];
  gapCount: number;
  gapCountKnown?: boolean;
  sources: { completed: number; total: number; quality: 'discovered' | 'unknown' };
  messages: {
    fetched: number;
    scanned: number;
    admitted: number;
    excluded: number;
    inserted: number;
    updated: number;
    unchanged: number;
    durable: number;
  };
  /** `stale`: messages whose membership refresh failed and was left marked stale. */
  reactions: { required: number; completed: number; stale?: number };
  reactionCountKnown?: boolean;
  live?: { pending: number; oldestAgeMs: number; windowMs: number };
  nextRunAt?: number;
  primary?: ArchivePhaseProgress;
  recentThroughput?: { messages: number; windowMs: number; observedAt: number };
}

/** The only snapshot version written and read; any other stored snapshot reads as no progress. */
const ARCHIVE_PROGRESS_VERSION = 2 as const;
const units = ['messages', 'documents', 'operations', 'channels', 'checks'] as const;
const qualities = ['exact', 'discovered', 'estimated', 'unknown'] as const;
const states = [
  'queued',
  'running',
  'paused',
  'waiting',
  'cancelling',
  'complete',
  'partial',
  'failed',
  'cancelled',
] as const satisfies readonly ArchiveProgressState[];
const steps = [
  'fetching',
  'processing',
  'writing',
  'reactions',
  'checkpoint',
  'waiting',
  'queued',
  'draining',
] as const satisfies readonly ArchiveActivityStep[];
const reasons = [
  'permission',
  'discovery',
  'capacity',
  'conflict',
  'other',
] as const satisfies readonly ArchiveGapReason[];
/** Estimate reasons a snapshot may name; anything else reads as `observed-throughput`. */
const estimateReasons = [
  'observed-throughput',
  'currently-known-work-only',
  'observed-phase-throughput',
  'observed-throughput-with-overlap-and-contention',
] as const;
export const safeArchiveName = (value: unknown): string =>
  typeof value === 'string'
    ? Array.from(value, (character) => (character.charCodeAt(0) < 32 ? ' ' : character))
        .join('')
        .slice(0, 100)
    : '';

const toRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** An object whose fields fall back individually; a non-object reads as `{}`. */
const lenientObject = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess(toRecord, z.object(shape));
/** Any JavaScript number, `NaN` included. */
const anyNumber = z.union([z.number(), z.nan()]);
const nonNegative = z.number().finite().nonnegative();
/** A counter: invalid values read as 0. */
const count = nonNegative.catch(0);
const time = nonNegative.max(8_640_000_000_000_000);
/** A timestamp: invalid values read as 0. */
const timestamp = time.catch(0);
/** Present only when stored as a number; invalid numbers read as 0. */
const presentCount = anyNumber.pipe(count).optional().catch(undefined);
const presentTime = anyNumber.pipe(timestamp).optional().catch(undefined);
/** Present only when valid. */
const validCount = nonNegative.optional().catch(undefined);
/** A counter and whether it was stored as an exact non-negative integer. */
const exactCount = z.unknown().transform((value) => ({
  value: count.parse(value),
  exact: z.number().int().safe().nonnegative().safeParse(value).success,
}));
const reference = z
  .string()
  .regex(/^[A-Za-z0-9:_-]{1,160}$/)
  .optional()
  .catch(undefined);
const notFalse = z.literal(false).optional().catch(undefined);
const displayName = z.string().catch('').transform(safeArchiveName);

const phaseSchema = (phase: ArchivePhase) =>
  lenientObject({
    committed: count,
    scanned: count,
    admitted: count,
    unit: z.enum(units).catch(phase === 'history' ? 'messages' : 'documents'),
    quality: z.enum(qualities).catch('unknown'),
    total: z.number().finite().optional().catch(undefined),
    referenceTotal: presentCount,
    rates: z.array(z.unknown()).catch([]),
  });
const activitySchema = lenientObject({
  sourceId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
  name: displayName,
  step: z.enum(steps),
  scanned: count,
  updatedAt: timestamp,
  startedAt: timestamp,
  pageProcessed: validCount,
  pageTotal: validCount,
  reactionUsers: validCount,
  reactionPages: validCount,
  provisional: z.literal(true).optional().catch(undefined),
  direction: z.literal('before').optional().catch(undefined),
  cursor: reference,
  waitSince: presentTime,
  retryAt: presentTime,
});
const gapSchema = lenientObject({
  sourceId: reference,
  name: z.string().transform(safeArchiveName).optional().catch(undefined),
  reason: z.enum(reasons).catch('other'),
});
const estimateSchema = lenientObject({
  lowerMs: nonNegative,
  upperMs: z.number().finite(),
  scope: z.enum(['phase', 'run']),
  reason: z.preprocess(String, z.enum(estimateReasons)).catch('observed-throughput'),
  phase: z.enum(archivePhases).optional().catch(undefined),
})
  .refine((estimate) => estimate.upperMs >= estimate.lowerMs)
  .transform(
    ({ lowerMs, upperMs, scope, reason, phase }): ArchiveRemainingEstimate => ({
      lowerMs,
      upperMs,
      scope,
      confidence: 'low',
      reason,
      ...(phase === undefined ? {} : { phase }),
    }),
  )
  .optional()
  .catch(undefined);

/**
 * Stored progress: a snapshot of another version or without a known phase or state
 * is rejected, and every other field falls back on its own.
 */
const storedProgressSchema = lenientObject({
  version: z.literal(ARCHIVE_PROGRESS_VERSION),
  work: z.enum(['full-backup', 'periodic']).catch('periodic'),
  jobId: reference,
  runId: reference,
  scanId: reference,
  cutoff: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .optional()
    .catch(undefined),
  cutoffKnown: notFalse,
  startedAt: timestamp,
  phase: z.enum(archivePhases),
  substep: z.preprocess(String, z.enum(archivePhases)).optional().catch(undefined),
  state: z.enum(states),
  reason: z.enum(reasons).optional().catch(undefined),
  phases: lenientObject({
    discovery: phaseSchema('discovery'),
    history: phaseSchema('history'),
    reactions: phaseSchema('reactions'),
    verification: phaseSchema('verification'),
  }),
  elapsedMs: count,
  activeMs: count,
  pausedMs: count,
  updatedAt: timestamp,
  lastProgressAt: timestamp,
  estimatedAt: timestamp,
  lastCheckpointAt: presentTime,
  estimating: z.boolean().catch(false),
  activities: z.array(z.unknown()).catch([]),
  activityCount: count,
  gaps: z.array(z.unknown()).optional().catch(undefined),
  gapCount: exactCount,
  gapCountKnown: notFalse,
  sources: lenientObject({
    completed: count,
    total: exactCount,
    quality: z.literal('unknown').optional().catch(undefined),
  }),
  recentThroughput: lenientObject({
    messages: nonNegative,
    windowMs: z.number().finite().min(1000),
    observedAt: time.positive(),
  })
    .optional()
    .catch(undefined),
  messages: lenientObject({
    fetched: count,
    scanned: count,
    admitted: count,
    excluded: count,
    inserted: count,
    updated: count,
    unchanged: count,
    durable: count,
  }),
  reactions: lenientObject({
    required: exactCount,
    completed: exactCount,
    stale: presentCount,
  }),
  reactionCountKnown: notFalse,
  live: lenientObject({ pending: count, oldestAgeMs: count, windowMs: count }).optional(),
  estimate: estimateSchema,
  phaseEstimate: estimateSchema,
  nextRunAt: presentTime,
  primary: lenientObject({
    committed: count,
    scanned: count,
    admitted: count,
    unit: z.enum(units).catch('documents'),
    quality: z.enum(qualities).catch('unknown'),
    total: z.number().finite().pipe(count).optional().catch(undefined),
  }).optional(),
});

const positiveRate = z.number().finite().positive();

/** Only explicit display metadata crosses the private status and notification boundary. */
export function sanitizeArchiveProgress(
  value: unknown,
  options: { includeRates?: boolean } = {},
): ArchiveProgressSnapshot | undefined {
  const parsed = storedProgressSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const phases = Object.fromEntries(
    archivePhases.map((key) => {
      const counters = data.phases[key];
      const { total, referenceTotal } = counters;
      return [
        key,
        {
          committed: counters.committed,
          scanned: counters.scanned,
          admitted: counters.admitted,
          unit: counters.unit,
          quality: counters.quality,
          ...(total !== undefined && total >= counters.committed ? { total } : {}),
          ...(referenceTotal === undefined ? {} : { referenceTotal }),
          ...(options.includeRates
            ? {
                rates: counters.rates
                  .filter((rate): rate is number => positiveRate.safeParse(rate).success)
                  .slice(-16),
              }
            : {}),
        },
      ];
    }),
  ) as Record<ArchivePhase, ArchivePhaseProgress>;
  const activities = data.activities.slice(0, 3).flatMap((raw): ArchiveActivity[] => {
    const parsedActivity = activitySchema.safeParse(raw);
    if (!parsedActivity.success) return [];
    const activity = parsedActivity.data;
    return [
      {
        sourceId: activity.sourceId,
        name: activity.name,
        step: activity.step,
        scanned: activity.scanned,
        updatedAt: activity.updatedAt,
        startedAt: activity.startedAt,
        ...(activity.pageProcessed === undefined ? {} : { pageProcessed: activity.pageProcessed }),
        ...(activity.pageTotal === undefined ? {} : { pageTotal: activity.pageTotal }),
        ...(activity.reactionUsers === undefined ? {} : { reactionUsers: activity.reactionUsers }),
        ...(activity.reactionPages === undefined ? {} : { reactionPages: activity.reactionPages }),
        ...(activity.provisional === undefined ? {} : { provisional: true }),
        ...(activity.direction === undefined ? {} : { direction: 'before' as const }),
        ...(activity.cursor === undefined ? {} : { cursor: activity.cursor }),
        ...(activity.waitSince === undefined ? {} : { waitSince: activity.waitSince }),
        ...(activity.retryAt === undefined ? {} : { retryAt: activity.retryAt }),
      },
    ];
  });
  const gaps = (data.gaps ?? []).slice(0, 3).map((raw): ArchiveScopeGap => {
    const gap = gapSchema.parse(raw);
    return {
      ...(gap.sourceId === undefined ? {} : { sourceId: gap.sourceId }),
      ...(gap.name === undefined ? {} : { name: gap.name }),
      reason: gap.reason,
    };
  });
  const { sources, reactions, primary } = data;
  return {
    version: ARCHIVE_PROGRESS_VERSION,
    work: data.work,
    ...(data.jobId === undefined ? {} : { jobId: data.jobId }),
    ...(data.runId === undefined ? {} : { runId: data.runId }),
    ...(data.scanId === undefined ? {} : { scanId: data.scanId }),
    cutoff: data.cutoff ?? new Date(0).toISOString(),
    cutoffKnown: data.cutoffKnown === undefined && data.cutoff !== undefined,
    startedAt: data.startedAt,
    phase: data.phase,
    substep: data.substep ?? data.phase,
    state: data.state,
    ...(data.reason === undefined ? {} : { reason: data.reason }),
    phases,
    elapsedMs: data.elapsedMs,
    activeMs: data.activeMs,
    pausedMs: data.pausedMs,
    updatedAt: data.updatedAt,
    lastProgressAt: data.lastProgressAt,
    estimatedAt: data.estimatedAt,
    ...(data.lastCheckpointAt === undefined ? {} : { lastCheckpointAt: data.lastCheckpointAt }),
    estimating: data.estimating,
    activities,
    activityCount: Math.max(activities.length, data.activityCount),
    gaps,
    gapCount: Math.max(gaps.length, data.gapCount.value),
    gapCountKnown:
      data.gapCountKnown === undefined && (data.gapCount.exact || data.gaps !== undefined),
    sources: {
      completed: sources.completed,
      total: sources.total.value,
      quality: sources.quality === undefined && sources.total.exact ? 'discovered' : 'unknown',
    },
    ...(data.recentThroughput === undefined ? {} : { recentThroughput: data.recentThroughput }),
    messages: data.messages,
    reactions: {
      required: reactions.required.value,
      completed: reactions.completed.value,
      ...(reactions.stale === undefined ? {} : { stale: reactions.stale }),
    },
    reactionCountKnown:
      data.reactionCountKnown === undefined &&
      reactions.required.exact &&
      reactions.completed.exact,
    ...(data.live === undefined ? {} : { live: data.live }),
    ...(data.estimate === undefined ? {} : { estimate: data.estimate }),
    ...(data.phaseEstimate === undefined ? {} : { phaseEstimate: data.phaseEstimate }),
    ...(data.nextRunAt === undefined ? {} : { nextRunAt: data.nextRunAt }),
    ...(primary === undefined
      ? {}
      : {
          primary: {
            committed: primary.committed,
            scanned: primary.scanned,
            admitted: primary.admitted,
            unit: primary.unit,
            quality: primary.quality,
            ...(primary.total === undefined ? {} : { total: primary.total }),
          },
        }),
  };
}

/** The saved progress of a job record, or an empty snapshot before its first update. */
export function archiveJobProgress(job: ArchiveJob, now = Date.now()): ArchiveProgressSnapshot {
  const saved = sanitizeArchiveProgress(toRecord(job.result)['progress']);
  const state: ArchiveProgressState =
    job.status === 'running' && job.cancelRequested ? 'cancelling' : job.status;
  const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(state);
  const startedAt = job.startedAt ?? job.createdAt;
  const elapsedMs = Math.max(0, (job.finishedAt ?? now) - startedAt);
  const cutoff = archiveJobCutoff(job);
  const phases = Object.fromEntries(
    archivePhases.map((key) => [
      key,
      {
        committed: 0,
        scanned: 0,
        admitted: 0,
        rates: [],
        quality: 'unknown',
        unit: key === 'history' ? 'messages' : 'checks',
      },
    ]),
  ) as unknown as Record<ArchivePhase, ArchivePhaseProgress>;
  return {
    ...(saved ?? {
      version: ARCHIVE_PROGRESS_VERSION,
      work: job.command,
      cutoff: new Date(
        timestamp.parse(typeof cutoff === 'number' ? cutoff : job.createdAt),
      ).toISOString(),
      cutoffKnown: typeof cutoff === 'number',
      startedAt,
      phase: 'discovery',
      substep: 'discovery',
      state,
      phases,
      elapsedMs,
      activeMs: job.status === 'queued' ? 0 : elapsedMs,
      pausedMs: 0,
      updatedAt: job.finishedAt ?? now,
      lastProgressAt: startedAt,
      estimatedAt: now,
      estimating: !terminal,
      activities: [],
      activityCount: 0,
      gaps: [],
      gapCount: 0,
      sources: { completed: 0, total: 0, quality: 'unknown' },
      messages: {
        fetched: 0,
        scanned: 0,
        admitted: 0,
        excluded: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        durable: 0,
      },
      reactions: { required: 0, completed: 0 },
    }),
    jobId: job.jobId,
    work: job.command,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    state,
    ...(terminal
      ? {
          estimating: false,
          estimate: undefined,
          phaseEstimate: undefined,
          activities: [],
          activityCount: 0,
        }
      : {}),
  };
}
