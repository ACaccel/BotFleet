import type { ArchiveJob } from './types';

const archivePhases = ['discovery', 'history', 'reactions', 'repair', 'verification'] as const;
export type ArchivePhase = (typeof archivePhases)[number];
export type ArchiveProgressState = ArchiveJob['status'] | 'paused' | 'waiting' | 'cancelling';
export type ArchiveProgressUnit = 'messages' | 'documents' | 'operations' | 'channels' | 'checks';
export type ArchiveDenominatorQuality = 'exact' | 'discovered' | 'estimated' | 'unknown';
type ArchiveActivityStep =
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
interface ArchiveValidationOutcome {
  state: 'passed' | 'incomplete' | 'previously-accepted';
  checks?: {
    pendingOperations: number;
    unresolvedEvidence: number;
    invalidOperations: number;
    missingDependencies: number;
  };
  coverage?: 'complete' | 'incomplete' | 'timestamps-only';
  recoveryExpiresAt?: number;
}
export interface ArchiveProgressSnapshot {
  version: 2;
  work: ArchiveJob['command'] | 'periodic';
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
  reactions: { required: number; completed: number };
  reactionCountKnown?: boolean;
  live?: { pending: number; oldestAgeMs: number; windowMs: number };
  candidates?: { timestamps: number; duplicates: number; excluded: number };
  outcomes?: { restored: number; conflicts: number; skipped: number };
  nextAction?: 'replan' | 'resume' | 'status';
  nextRunAt?: number;
  primary?: ArchivePhaseProgress;
  messageCountQuality: 'exact' | 'lower-bound';
  validation?: ArchiveValidationOutcome;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const timestamp = (value: unknown): number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000
    ? value
    : 0;
const reference = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value) ? value : undefined;
const validationOutcome = (value: unknown): ArchiveValidationOutcome | undefined => {
  const data = record(value);
  if (!['passed', 'incomplete', 'previously-accepted'].includes(String(data['state'])))
    return undefined;
  const checks = record(data['checks']);
  const checkKeys = [
    'pendingOperations',
    'unresolvedEvidence',
    'invalidOperations',
    'missingDependencies',
  ] as const;
  const hasChecks = checkKeys.every(
    (key) => Number.isSafeInteger(checks[key]) && Number(checks[key]) >= 0,
  );
  if (data['state'] !== 'previously-accepted' && !hasChecks) return undefined;
  return {
    state:
      data['state'] === 'passed' && checkKeys.some((key) => Number(checks[key]) > 0)
        ? 'incomplete'
        : (data['state'] as ArchiveValidationOutcome['state']),
    ...(hasChecks
      ? {
          checks: Object.fromEntries(checkKeys.map((key) => [key, checks[key]])) as NonNullable<
            ArchiveValidationOutcome['checks']
          >,
        }
      : {}),
    ...(['complete', 'incomplete', 'timestamps-only'].includes(String(data['coverage']))
      ? { coverage: data['coverage'] as NonNullable<ArchiveValidationOutcome['coverage']> }
      : {}),
    ...(typeof data['recoveryExpiresAt'] === 'number' && timestamp(data['recoveryExpiresAt']) > 0
      ? { recoveryExpiresAt: timestamp(data['recoveryExpiresAt']) }
      : {}),
  };
};
const units: ArchiveProgressUnit[] = ['messages', 'documents', 'operations', 'channels', 'checks'];
const qualities: ArchiveDenominatorQuality[] = ['exact', 'discovered', 'estimated', 'unknown'];
const states: ArchiveProgressState[] = [
  'queued',
  'running',
  'paused',
  'waiting',
  'cancelling',
  'complete',
  'partial',
  'failed',
  'cancelled',
];
const steps: ArchiveActivityStep[] = [
  'fetching',
  'processing',
  'writing',
  'reactions',
  'checkpoint',
  'waiting',
  'queued',
  'draining',
];
const substeps = [
  ...archivePhases,
  'check-messages',
  'check-duplicate-identities',
  'check-legacy-cursors',
  'plan-legacy-cursors',
  'validate-manifest',
  'apply-manifest',
  'rollback-manifest',
  'attachment-access',
  'attachment-fetch',
  'attachment-write',
];
const reasons: ArchiveGapReason[] = ['permission', 'discovery', 'capacity', 'conflict', 'other'];
export const safeArchiveName = (value: unknown): string =>
  typeof value === 'string'
    ? Array.from(value, (character) => (character.charCodeAt(0) < 32 ? ' ' : character))
        .join('')
        .slice(0, 100)
    : '';

/** Only explicit display metadata crosses the private status and notification boundary. */
export function sanitizeArchiveProgress(
  value: unknown,
  options: { includeRates?: boolean } = {},
): ArchiveProgressSnapshot | undefined {
  const data = record(value);
  if (data['version'] !== undefined && data['version'] !== 1 && data['version'] !== 2)
    return undefined;
  if (
    !archivePhases.includes(data['phase'] as ArchivePhase) ||
    !states.includes(data['state'] as ArchiveProgressState)
  )
    return undefined;
  const phase = data['phase'] as ArchivePhase;
  const work = data['work'];
  const phases = Object.fromEntries(
    archivePhases.map((key) => {
      const counters = record(record(data['phases'])[key]);
      const total = counters['total'];
      const quality = qualities.includes(counters['quality'] as ArchiveDenominatorQuality)
        ? (counters['quality'] as ArchiveDenominatorQuality)
        : 'unknown';
      return [
        key,
        {
          committed: finite(counters['committed']),
          scanned: finite(counters['scanned']),
          admitted: finite(counters['admitted']),
          unit: units.includes(counters['unit'] as ArchiveProgressUnit)
            ? (counters['unit'] as ArchiveProgressUnit)
            : key === 'history'
              ? 'messages'
              : 'documents',
          quality,
          ...(typeof total === 'number' &&
          Number.isFinite(total) &&
          total >= finite(counters['committed'])
            ? { total }
            : {}),
          ...(typeof counters['referenceTotal'] === 'number'
            ? { referenceTotal: finite(counters['referenceTotal']) }
            : {}),
          ...(options.includeRates
            ? {
                rates: Array.isArray(counters['rates'])
                  ? counters['rates']
                      .filter(
                        (rate): rate is number =>
                          typeof rate === 'number' && Number.isFinite(rate) && rate > 0,
                      )
                      .slice(-16)
                  : [],
              }
            : {}),
        },
      ];
    }),
  ) as Record<ArchivePhase, ArchivePhaseProgress>;
  const activities = (Array.isArray(data['activities']) ? data['activities'] : [])
    .slice(0, 3)
    .flatMap((raw): ArchiveActivity[] => {
      const activity = record(raw);
      const sourceId = reference(activity['sourceId']);
      if (sourceId === undefined || !steps.includes(activity['step'] as ArchiveActivityStep))
        return [];
      return [
        {
          sourceId,
          name: safeArchiveName(activity['name']),
          step: activity['step'] as ArchiveActivityStep,
          scanned: finite(activity['scanned']),
          updatedAt: timestamp(activity['updatedAt']),
          startedAt: timestamp(activity['startedAt']),
          ...(typeof activity['pageProcessed'] === 'number' &&
          Number.isFinite(activity['pageProcessed']) &&
          activity['pageProcessed'] >= 0
            ? { pageProcessed: finite(activity['pageProcessed']) }
            : {}),
          ...(typeof activity['pageTotal'] === 'number' &&
          Number.isFinite(activity['pageTotal']) &&
          activity['pageTotal'] >= 0
            ? { pageTotal: finite(activity['pageTotal']) }
            : {}),
          ...(typeof activity['reactionUsers'] === 'number' &&
          Number.isFinite(activity['reactionUsers']) &&
          activity['reactionUsers'] >= 0
            ? { reactionUsers: finite(activity['reactionUsers']) }
            : {}),
          ...(typeof activity['reactionPages'] === 'number' &&
          Number.isFinite(activity['reactionPages']) &&
          activity['reactionPages'] >= 0
            ? { reactionPages: finite(activity['reactionPages']) }
            : {}),
          ...(activity['provisional'] === true ? { provisional: true } : {}),
          ...(activity['direction'] === 'before' ? { direction: 'before' as const } : {}),
          ...(reference(activity['cursor']) === undefined
            ? {}
            : { cursor: reference(activity['cursor']) }),
          ...(typeof activity['waitSince'] === 'number'
            ? { waitSince: timestamp(activity['waitSince']) }
            : {}),
          ...(typeof activity['retryAt'] === 'number'
            ? { retryAt: timestamp(activity['retryAt']) }
            : {}),
        },
      ];
    });
  const gaps = (Array.isArray(data['gaps']) ? data['gaps'] : [])
    .slice(0, 3)
    .map((raw): ArchiveScopeGap => {
      const gap = record(raw);
      return {
        ...(reference(gap['sourceId']) === undefined
          ? {}
          : { sourceId: reference(gap['sourceId']) }),
        ...(typeof gap['name'] === 'string' ? { name: safeArchiveName(gap['name']) } : {}),
        reason: reasons.includes(gap['reason'] as ArchiveGapReason)
          ? (gap['reason'] as ArchiveGapReason)
          : 'other',
      };
    });
  const numerical = <T extends string>(raw: unknown, keys: readonly T[]): Record<T, number> =>
    Object.fromEntries(keys.map((key) => [key, finite(record(raw)[key])])) as Record<T, number>;
  const estimate = (raw: unknown): ArchiveRemainingEstimate | undefined => {
    const item = record(raw);
    if (
      !['phase', 'run'].includes(String(item['scope'])) ||
      typeof item['lowerMs'] !== 'number' ||
      typeof item['upperMs'] !== 'number' ||
      !Number.isFinite(item['lowerMs']) ||
      !Number.isFinite(item['upperMs']) ||
      item['lowerMs'] < 0 ||
      item['upperMs'] < item['lowerMs']
    )
      return undefined;
    return {
      lowerMs: item['lowerMs'],
      upperMs: item['upperMs'],
      scope: item['scope'] as 'phase' | 'run',
      confidence: 'low',
      reason: [
        'currently-known-work-only',
        'observed-phase-throughput',
        'observed-throughput-with-overlap-and-contention',
      ].includes(String(item['reason']))
        ? String(item['reason'])
        : 'observed-throughput',
      ...(archivePhases.includes(item['phase'] as ArchivePhase)
        ? { phase: item['phase'] as ArchivePhase }
        : {}),
    };
  };
  return {
    version: 2,
    work: [
      'audit',
      'plan',
      'apply',
      'resume',
      'verify',
      'rollback',
      'accept',
      'backfill',
      'migrate-timestamp',
      'refresh-attachment',
      'periodic',
    ].includes(String(work))
      ? (work as ArchiveProgressSnapshot['work'])
      : 'periodic',
    ...(reference(data['jobId']) === undefined ? {} : { jobId: reference(data['jobId']) }),
    ...(reference(data['runId']) === undefined ? {} : { runId: reference(data['runId']) }),
    ...(reference(data['scanId']) === undefined ? {} : { scanId: reference(data['scanId']) }),
    cutoff:
      typeof data['cutoff'] === 'string' && Number.isFinite(Date.parse(data['cutoff']))
        ? data['cutoff']
        : new Date(0).toISOString(),
    cutoffKnown:
      data['cutoffKnown'] !== false &&
      typeof data['cutoff'] === 'string' &&
      Number.isFinite(Date.parse(data['cutoff'])),
    startedAt: timestamp(data['startedAt']),
    phase,
    substep: substeps.includes(String(data['substep'])) ? String(data['substep']) : phase,
    state: data['state'] as ArchiveProgressState,
    ...(reasons.includes(data['reason'] as ArchiveGapReason)
      ? { reason: data['reason'] as ArchiveGapReason }
      : {}),
    phases,
    elapsedMs: finite(data['elapsedMs']),
    activeMs: finite(data['activeMs'] ?? data['elapsedMs']),
    pausedMs: finite(data['pausedMs']),
    updatedAt: timestamp(data['updatedAt'] ?? data['estimatedAt']),
    lastProgressAt: timestamp(data['lastProgressAt'] ?? data['estimatedAt']),
    estimatedAt: timestamp(data['estimatedAt']),
    ...(typeof data['lastCheckpointAt'] === 'number'
      ? { lastCheckpointAt: timestamp(data['lastCheckpointAt']) }
      : {}),
    estimating: data['estimating'] === true,
    activities,
    activityCount: Math.max(activities.length, finite(data['activityCount'])),
    gaps,
    gapCount: Math.max(gaps.length, finite(data['gapCount'])),
    gapCountKnown:
      data['gapCountKnown'] !== false &&
      ((Number.isSafeInteger(data['gapCount']) && Number(data['gapCount']) >= 0) ||
        Array.isArray(data['gaps'])),
    sources: {
      completed: finite(record(data['sources'])['completed']),
      total: finite(record(data['sources'])['total']),
      quality:
        record(data['sources'])['quality'] !== 'unknown' &&
        Number.isSafeInteger(record(data['sources'])['total']) &&
        Number(record(data['sources'])['total']) >= 0
          ? 'discovered'
          : 'unknown',
    },
    messageCountQuality:
      data['messageCountQuality'] === 'lower-bound' || data['version'] !== 2
        ? 'lower-bound'
        : 'exact',
    ...(validationOutcome(data['validation']) === undefined
      ? {}
      : { validation: validationOutcome(data['validation']) }),
    messages: numerical(data['messages'], [
      'fetched',
      'scanned',
      'admitted',
      'excluded',
      'inserted',
      'updated',
      'unchanged',
      'durable',
    ]),
    reactions: numerical(data['reactions'], ['required', 'completed']),
    reactionCountKnown:
      data['reactionCountKnown'] !== false &&
      ['required', 'completed'].every(
        (key) =>
          Number.isSafeInteger(record(data['reactions'])[key]) &&
          Number(record(data['reactions'])[key]) >= 0,
      ),
    ...(data['live'] === undefined
      ? {}
      : { live: numerical(data['live'], ['pending', 'oldestAgeMs', 'windowMs']) }),
    ...(data['candidates'] === undefined
      ? {}
      : { candidates: numerical(data['candidates'], ['timestamps', 'duplicates', 'excluded']) }),
    ...(data['outcomes'] === undefined
      ? {}
      : { outcomes: numerical(data['outcomes'], ['restored', 'conflicts', 'skipped']) }),
    ...(estimate(
      data['estimate'] ?? (data['version'] === 2 ? undefined : data['phaseEstimate']),
    ) === undefined
      ? {}
      : {
          estimate: estimate(
            data['estimate'] ?? (data['version'] === 2 ? undefined : data['phaseEstimate']),
          ),
        }),
    ...(estimate(data['phaseEstimate']) === undefined
      ? {}
      : { phaseEstimate: estimate(data['phaseEstimate']) }),
    ...(['replan', 'resume', 'status'].includes(String(data['nextAction']))
      ? { nextAction: data['nextAction'] as 'replan' | 'resume' | 'status' }
      : {}),
    ...(typeof data['nextRunAt'] === 'number' ? { nextRunAt: timestamp(data['nextRunAt']) } : {}),
    ...(data['primary'] === undefined
      ? {}
      : {
          primary: {
            committed: finite(record(data['primary'])['committed']),
            scanned: finite(record(data['primary'])['scanned']),
            admitted: finite(record(data['primary'])['admitted']),
            unit: units.includes(record(data['primary'])['unit'] as ArchiveProgressUnit)
              ? (record(data['primary'])['unit'] as ArchiveProgressUnit)
              : 'documents',
            quality: qualities.includes(
              record(data['primary'])['quality'] as ArchiveDenominatorQuality,
            )
              ? (record(data['primary'])['quality'] as ArchiveDenominatorQuality)
              : 'unknown',
            ...(typeof record(data['primary'])['total'] === 'number' &&
            Number.isFinite(record(data['primary'])['total'])
              ? { total: finite(record(data['primary'])['total']) }
              : {}),
          },
        }),
  };
}

export function archiveJobProgress(job: ArchiveJob, now = Date.now()): ArchiveProgressSnapshot {
  const result = record(job.result);
  const saved = sanitizeArchiveProgress(result['progress']);
  const state: ArchiveProgressState =
    job.status === 'running' && job.cancelRequested ? 'cancelling' : job.status;
  const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(state);
  const phase: ArchivePhase = ['verify', 'accept'].includes(job.command)
    ? 'verification'
    : 'repair';
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
  const total = record(result['counts'])['total'];
  if (
    job.command === 'audit' &&
    terminal &&
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total >= 0
  )
    phases.repair = {
      committed: total,
      scanned: total,
      admitted: total,
      rates: [],
      quality: 'exact',
      unit: 'documents',
      total,
    };
  const issues = Array.isArray(result['issues']) ? result['issues'] : [];
  const reportedIssues = [...issues, ...(result['error'] === undefined ? [] : [result['error']])];
  const gapReasons = reportedIssues.map((issue): ArchiveGapReason => {
    const text = typeof issue === 'string' ? issue : '';
    return /permission|forbidden|access|denied/i.test(text)
      ? 'permission'
      : /space|capacity|disk|budget/i.test(text)
        ? 'capacity'
        : /conflict|changed/i.test(text)
          ? 'conflict'
          : /discovery|inventory|gap|thread/i.test(text)
            ? 'discovery'
            : 'other';
  });
  const startedAt = job.startedAt ?? job.createdAt;
  const elapsedMs = Math.max(0, (job.finishedAt ?? now) - startedAt);
  const counts = record(result['counts']);
  const details = record(result['details']);
  const verificationCounts = [
    'pending',
    'unresolvedEvidence',
    'invalidManifestOperations',
    'missingDependencies',
  ] as const;
  let validation: ArchiveValidationOutcome | undefined;
  // Completion counters alone cannot establish that the verifier ran.
  if (
    ['apply', 'resume', 'verify', 'accept'].includes(job.command) &&
    ['complete', 'partial'].includes(job.status) &&
    ['complete', 'partial'].includes(String(result['status'])) &&
    Array.isArray(result['issues']) &&
    verificationCounts.every((key) => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0)
  ) {
    const coverage = record(details['coverage']);
    validation = {
      state:
        job.status === 'complete' &&
        result['status'] === 'complete' &&
        issues.length === 0 &&
        verificationCounts.every((key) => counts[key] === 0)
          ? 'passed'
          : 'incomplete',
      checks: {
        pendingOperations: counts['pending'] as number,
        unresolvedEvidence: counts['unresolvedEvidence'] as number,
        invalidOperations: counts['invalidManifestOperations'] as number,
        missingDependencies: counts['missingDependencies'] as number,
      },
      ...(coverage['status'] === 'complete'
        ? {
            coverage:
              record(coverage['details'])['scope'] === 'timestamps-only'
                ? ('timestamps-only' as const)
                : ('complete' as const),
          }
        : ['partial', 'failed', 'cancelled'].includes(String(coverage['status']))
          ? { coverage: 'incomplete' as const }
          : {}),
    };
  }
  if (
    job.command === 'accept' &&
    job.status === 'complete' &&
    result['status'] === 'complete' &&
    Array.isArray(result['issues']) &&
    issues.length === 0 &&
    timestamp(details['acceptedAt']) > 0 &&
    timestamp(details['expiresAt']) > timestamp(details['acceptedAt'])
  )
    validation = {
      ...(validation ?? { state: 'previously-accepted' as const }),
      recoveryExpiresAt: timestamp(details['expiresAt']),
    };
  return {
    ...(saved ?? {
      version: 2,
      work: job.command,
      cutoff: new Date(timestamp(job.createdAt)).toISOString(),
      cutoffKnown: false,
      startedAt,
      phase,
      substep: phase,
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
      gapCountKnown: Array.isArray(result['issues']) || result['error'] !== undefined,
      sources: { completed: 0, total: 0, quality: 'unknown' },
      messageCountQuality: 'lower-bound',
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
    runId: job.runId,
    state,
    validation,
    ...(gapReasons.length === 0
      ? {}
      : {
          gaps: gapReasons.slice(0, 3).map((reason) => ({ reason })),
          gapCount: Math.max(saved?.gapCount ?? 0, gapReasons.length),
        }),
    ...(job.status === 'queued' ? { elapsedMs: Math.max(0, now - job.createdAt) } : {}),
    ...(terminal
      ? {
          estimating: false,
          estimate: undefined,
          phaseEstimate: undefined,
          activities: [],
          activityCount: 0,
        }
      : {}),
  } as ArchiveProgressSnapshot;
}
