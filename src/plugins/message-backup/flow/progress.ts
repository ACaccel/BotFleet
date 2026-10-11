import type {
  ArchiveActivity,
  ArchiveDenominatorQuality,
  ArchiveGapReason,
  ArchivePhaseProgress,
  ArchiveProgressSnapshot,
  ArchiveProgressState,
  ArchiveProgressUnit,
  ArchiveScopeGap,
} from '../../../core/archive/progress';
import { safeArchiveName, sanitizeArchiveProgress } from '../../../core/archive/progress';
import { archiveNotificationSecondsSchema } from '../../../core/archive/limits';
import type { ArchivePhase } from '../../../core/archive/progress';
export type { ArchivePhase } from '../../../core/archive/progress';
type ProgressState = ArchiveProgressState;
type PhaseProgress = ArchivePhaseProgress & { rates: number[] };
interface ProgressCheckpoint {
  cutoff: string;
  startedAt: number;
  phase: ArchivePhase;
  state: ProgressState;
  reason?: string;
  phases: Record<ArchivePhase, PhaseProgress>;
  acknowledgements: Record<string, number>;
}
export interface RemainingEstimate {
  lowerMs: number;
  upperMs: number;
  scope: 'phase' | 'run';
  phase?: ArchivePhase;
  confidence: 'low' | 'medium';
  reason: string;
}
type ProgressSnapshot = ArchiveProgressSnapshot;
interface ProgressOptions {
  cutoff: Date;
  clock?: () => number;
  restored?: ProgressCheckpoint;
  startedAt?: number;
  work?: ArchiveProgressSnapshot['work'];
  jobId?: string;
  runId?: string;
  scanId?: string;
}
const phases: ArchivePhase[] = ['discovery', 'history', 'reactions', 'verification'];

/** Only acknowledged work counts as complete. Persist checkpoint with the owning job's durable writes. */
export class ProgressTracker {
  private readonly clock: () => number;
  private readonly data: ProgressCheckpoint;
  private readonly lastSample = new Map<ArchivePhase, number>();
  private readonly sampleUnits = new Map<ArchivePhase, number>();
  private currentPhaseEstimate: RemainingEstimate | undefined;
  private readonly identity: Pick<ArchiveProgressSnapshot, 'work' | 'jobId' | 'runId' | 'scanId'>;
  private readonly activities = new Map<string, ArchiveActivity>();
  private readonly scopeGaps = new Map<string, ArchiveScopeGap>();
  private readonly completedSources = new Set<string>();
  private sourceTotal = 0;
  private lastProgressAt: number;
  private lastCheckpointAt: number | undefined;
  private pausedMs = 0;
  private pausedAt: number | undefined;
  private finishedAt: number | undefined;
  private recentHistory: { at: number; units: number }[] = [];
  private substep: string;
  private readonly messages: ArchiveProgressSnapshot['messages'] = {
    fetched: 0,
    scanned: 0,
    admitted: 0,
    excluded: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    durable: 0,
  };
  private readonly reactions = { required: 0, completed: 0, stale: 0 };
  private extras: Pick<ArchiveProgressSnapshot, 'live' | 'nextRunAt' | 'primary'> = {};
  private readonly stages = new Map<string, PhaseProgress>();

  constructor(options: ProgressOptions) {
    this.clock = options.clock ?? Date.now;
    this.identity = {
      work: options.work ?? 'periodic',
      jobId: options.jobId,
      runId: options.runId,
      scanId: options.scanId,
    };
    this.lastProgressAt = options.startedAt ?? this.clock();
    this.substep = 'discovery';
    if (!Number.isFinite(options.cutoff.getTime())) throw new Error('invalid-progress-cutoff');
    this.data =
      options.restored === undefined
        ? {
            cutoff: options.cutoff.toISOString(),
            startedAt: options.startedAt ?? this.clock(),
            phase: 'discovery',
            state: 'running',
            phases: {
              discovery: {
                committed: 0,
                scanned: 0,
                admitted: 0,
                rates: [],
                unit: 'channels',
                quality: 'unknown',
              },
              history: {
                committed: 0,
                scanned: 0,
                admitted: 0,
                rates: [],
                unit: 'messages',
                quality: 'unknown',
              },
              reactions: {
                committed: 0,
                scanned: 0,
                admitted: 0,
                rates: [],
                unit: 'messages',
                quality: 'unknown',
              },
              verification: {
                committed: 0,
                scanned: 0,
                admitted: 0,
                rates: [],
                unit: 'checks',
                quality: 'unknown',
              },
            },
            acknowledgements: {},
          }
        : structuredClone(options.restored);
    // Persisted speed samples can be stale after downtime; committed counters and cutoff remain authoritative.
    for (const phase of phases) {
      this.data.phases[phase].rates = [];
      this.data.phases[phase].quality ??= 'unknown';
      this.data.phases[phase].unit ??= phase === 'history' ? 'messages' : 'documents';
      this.lastSample.set(phase, this.clock());
    }
  }
  setPhase(phase: ArchivePhase): void {
    this.data.phase = phase;
    this.substep = phase;
  }
  setTotal(
    phase: ArchivePhase,
    total: number | undefined,
    quality: ArchiveDenominatorQuality = total === undefined ? 'unknown' : 'exact',
    unit?: ArchiveProgressUnit,
  ): void {
    if (
      total !== undefined &&
      (!Number.isSafeInteger(total) || total < this.data.phases[phase].committed)
    )
      throw new Error('invalid-progress-total');
    this.data.phases[phase].quality = quality;
    if (unit !== undefined) this.data.phases[phase].unit = unit;
    if (quality === 'estimated') {
      this.data.phases[phase].referenceTotal = total;
      this.data.phases[phase].total = undefined;
    } else this.data.phases[phase].total = total;
  }
  observe(phase: ArchivePhase, scanned: number, admitted = scanned): void {
    this.validateUnits(scanned);
    this.validateUnits(admitted);
    this.data.phases[phase].scanned += scanned;
    this.data.phases[phase].admitted += admitted;
  }
  commit(
    phase: ArchivePhase,
    units: number,
    stream: string,
    sequence: number,
    restored = false,
    checkpointAt?: number,
  ): boolean {
    this.validateUnits(units);
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error('invalid-progress-sequence');
    const key = `${phase}:${stream}`;
    if ((this.data.acknowledgements[key] ?? -1) >= sequence) return false;
    if (
      !(key in this.data.acknowledgements) &&
      Object.keys(this.data.acknowledgements).length >= 100000
    )
      throw new Error('progress-stream-limit');
    this.data.acknowledgements[key] = sequence;
    const current = this.data.phases[phase];
    current.committed += units;
    if (current.total !== undefined && current.total < current.committed) current.total = undefined;
    if (restored) {
      if (checkpointAt !== undefined && Number.isFinite(checkpointAt) && checkpointAt > 0)
        this.lastCheckpointAt = Math.max(this.lastCheckpointAt ?? 0, checkpointAt);
      return true;
    }
    if (phase === 'history' && this.data.state === 'running') {
      const at = this.clock();
      this.recentHistory.push({ at, units });
      this.recentHistory = this.recentHistory
        .filter((sample) => at - sample.at <= 60_000)
        .slice(-100);
    }
    if (units > 0) this.lastProgressAt = this.clock();
    this.lastCheckpointAt = this.clock();
    const now = this.clock();
    const interval = now - (this.lastSample.get(phase) ?? now);
    const accumulated = (this.sampleUnits.get(phase) ?? 0) + units;
    this.sampleUnits.set(phase, accumulated);
    if (interval >= 1000 && units > 0 && this.data.state === 'running') {
      current.rates.push(accumulated / interval);
      this.sampleUnits.set(phase, 0);
      this.lastSample.set(phase, now);
      if (current.rates.length > 16) current.rates.shift();
    }
    return true;
  }
  pause(reason: string): void {
    this.recentHistory = [];
    this.data.state = 'paused';
    this.data.reason = reason;
    this.pausedAt ??= this.clock();
  }
  resume(): void {
    if (this.pausedAt !== undefined) this.pausedMs += Math.max(0, this.clock() - this.pausedAt);
    this.pausedAt = undefined;
    this.data.state = 'running';
    this.data.reason = undefined;
    for (const phase of phases) {
      this.lastSample.set(phase, this.clock());
      this.data.phases[phase].rates = [];
      this.sampleUnits.set(phase, 0);
    }
  }
  seedRates(phase: ArchivePhase, rates: readonly number[]): void {
    if (rates.some((rate) => !Number.isFinite(rate) || rate <= 0))
      throw new Error('invalid-progress-rate');
    this.data.phases[phase].rates = rates.slice(-16);
  }
  finish(state: 'complete' | 'partial' | 'failed' | 'cancelled', reason?: string): void {
    if (
      state === 'complete' &&
      phases.some(
        (phase) =>
          this.data.phases[phase].total === undefined ||
          this.data.phases[phase].committed < this.data.phases[phase].total!,
      )
    )
      throw new Error('progress-work-incomplete');
    this.data.state = state;
    this.data.reason = reason;
    this.finishedAt ??= this.clock();
    if (this.pausedAt !== undefined) {
      this.pausedMs += Math.max(0, this.finishedAt - this.pausedAt);
      this.pausedAt = undefined;
    }
    this.activities.clear();
  }
  setCurrentPhaseEstimate(estimate: RemainingEstimate | undefined): void {
    this.currentPhaseEstimate = estimate;
  }
  checkpoint(): ProgressCheckpoint {
    return structuredClone(this.data);
  }
  setSubstep(value: string): void {
    this.substep = value;
  }
  report(
    phase: ArchivePhase,
    committed: number,
    total: number | undefined,
    quality: ArchiveDenominatorQuality,
    unit: ArchiveProgressUnit,
    substep: string,
    stream: string,
  ): void {
    this.validateUnits(committed);
    const key = `${phase}:${stream}:${unit}`;
    const current = this.stages.get(key) ?? {
      committed: 0,
      scanned: 0,
      admitted: 0,
      rates: [],
      unit,
      quality,
    };
    this.data.phases[phase] = current;
    this.stages.set(key, current);
    if (this.stages.size > 16) this.stages.delete(this.stages.keys().next().value!);
    const delta = Math.max(0, committed - current.committed);
    this.data.phase = phase;
    this.substep = substep;
    current.committed = committed;
    current.scanned = committed;
    current.admitted = committed;
    this.setTotal(
      phase,
      total === undefined ? undefined : Math.max(total, committed),
      quality,
      unit,
    );
    if (delta > 0) this.lastProgressAt = this.clock();
    const interval = this.clock() - (this.lastSample.get(phase) ?? this.clock());
    const accumulated = (this.sampleUnits.get(phase) ?? 0) + delta;
    this.sampleUnits.set(phase, accumulated);
    if (interval >= 1000 && accumulated > 0) {
      current.rates.push(accumulated / interval);
      if (current.rates.length > 16) current.rates.shift();
      this.lastSample.set(phase, this.clock());
      this.sampleUnits.set(phase, 0);
    }
    if (unit === 'documents' || unit === 'operations')
      this.extras.primary = structuredClone(current);
  }
  setState(state: 'waiting' | 'cancelling' | 'running', reason?: string): void {
    this.data.state = state;
    this.data.reason = reason;
  }
  activity(sourceId: string, update: Partial<Omit<ArchiveActivity, 'sourceId'>> | undefined): void {
    if (update === undefined) {
      this.activities.delete(sourceId);
      return;
    }
    const previous = this.activities.get(sourceId);
    if (previous === undefined && this.activities.size >= 64)
      throw new Error('Archive active-source bound exceeded');
    const step = update.step ?? previous?.step ?? 'processing';
    this.activities.set(sourceId, {
      ...previous,
      ...update,
      sourceId,
      name: safeArchiveName(update.name ?? previous?.name ?? sourceId),
      step,
      scanned: update.scanned ?? previous?.scanned ?? 0,
      startedAt: previous?.startedAt ?? this.clock(),
      updatedAt: this.clock(),
      ...(step === 'waiting' ? {} : { waitSince: undefined, retryAt: undefined }),
      ...(step === 'fetching'
        ? { pageProcessed: undefined, pageTotal: undefined, provisional: undefined }
        : {}),
      ...(['reactions', 'waiting'].includes(step)
        ? {}
        : { reactionUsers: undefined, reactionPages: undefined }),
    });
  }
  activityDetails(): ArchiveActivity[] {
    return [...this.activities.values()].sort(
      (a, b) => a.startedAt - b.startedAt || a.sourceId.localeCompare(b.sourceId),
    );
  }
  gapDetails(): ArchiveScopeGap[] {
    return [...this.scopeGaps.values()];
  }
  setSources(total: number): void {
    this.validateUnits(total);
    this.sourceTotal = total;
  }
  completeSource(sourceId: string): void {
    if (this.completedSources.has(sourceId)) return;
    if (this.completedSources.size >= 100000)
      throw new Error('Archive completed-source bound exceeded');
    this.completedSources.add(sourceId);
    this.activities.delete(sourceId);
    this.lastProgressAt = this.clock();
  }
  gap(gap: ArchiveScopeGap): void {
    const key = `${gap.sourceId ?? ''}:${gap.reason}`;
    if (!this.scopeGaps.has(key) && this.scopeGaps.size >= 10000)
      throw new Error('Archive scope-gap bound exceeded');
    this.scopeGaps.set(key, {
      ...gap,
      ...(gap.name === undefined ? {} : { name: safeArchiveName(gap.name) }),
    });
  }
  messageCounts(values: Partial<ArchiveProgressSnapshot['messages']>): void {
    for (const [key, value] of Object.entries(values)) {
      this.validateUnits(value);
      const field = key as keyof typeof this.messages;
      this.messages[field] = (this.messages[field] ?? 0) + value;
    }
    if ((values.durable ?? 0) > 0) this.lastProgressAt = this.clock();
  }
  reactionDiscovered(units = 1): void {
    this.validateUnits(units);
    this.reactions.required += units;
  }
  reactionCompleted(units = 1): void {
    this.validateUnits(units);
    this.reactions.completed += units;
    if (units > 0) this.lastProgressAt = this.clock();
  }
  /** A message whose membership refresh failed; it stays marked stale. */
  reactionStale(units = 1): void {
    this.validateUnits(units);
    this.reactions.stale += units;
  }
  setExtras(extras: Partial<typeof this.extras>): void {
    this.extras = { ...this.extras, ...extras };
  }
  snapshot(): ProgressSnapshot {
    const now = this.clock();
    const wallEnd = this.finishedAt ?? now;
    const pausedMs =
      this.pausedMs + (this.pausedAt === undefined ? 0 : Math.max(0, wallEnd - this.pausedAt));
    const { acknowledgements: _acknowledgements, reason, ...checkpoint } = this.checkpoint();
    // Prefer real recent work over an older stalled source; detail pagination keeps its stable order.
    const activities = this.activityDetails().sort(
      (a, b) =>
        Number(a.step === 'waiting') - Number(b.step === 'waiting') ||
        b.updatedAt - a.updatedAt ||
        a.sourceId.localeCompare(b.sourceId),
    );
    const snapshot: ProgressSnapshot = {
      ...checkpoint,
      version: 2,
      ...this.identity,
      substep: this.substep,
      ...(reason === undefined
        ? {}
        : {
            reason: /permission|access|forbidden/i.test(reason)
              ? ('permission' as ArchiveGapReason)
              : /capacity|disk|budget/i.test(reason)
                ? ('capacity' as ArchiveGapReason)
                : ('other' as ArchiveGapReason),
          }),
      elapsedMs: Math.max(0, wallEnd - this.data.startedAt),
      activeMs: Math.max(0, wallEnd - this.data.startedAt - pausedMs),
      pausedMs,
      updatedAt: now,
      lastProgressAt: this.lastProgressAt,
      lastCheckpointAt: this.lastCheckpointAt,
      activities: activities.slice(0, 3),
      activityCount: activities.length,
      gaps: [...this.scopeGaps.values()].slice(0, 3),
      gapCount: this.scopeGaps.size,
      sources: {
        total: this.sourceTotal,
        completed: this.completedSources.size,
        quality: 'discovered',
      },
      ...(this.recentThroughput(now) === undefined
        ? {}
        : { recentThroughput: this.recentThroughput(now) }),
      messages: { ...this.messages },
      reactions: { ...this.reactions },
      ...this.extras,
      estimatedAt: now,
      estimating: this.data.state === 'running',
    };
    if (
      snapshot.state === 'running' &&
      activities.length > 0 &&
      activities.every((activity) => activity.step === 'waiting')
    )
      snapshot.state = 'waiting';
    if (this.data.state !== 'running') {
      snapshot.estimating = false;
      return sanitizeArchiveProgress(snapshot, { includeRates: true })!;
    }
    const phaseEstimate = this.estimate(this.data.phase);
    if (phaseEstimate !== undefined)
      snapshot.phaseEstimate = {
        ...phaseEstimate,
        scope: 'phase',
        confidence: 'low',
        reason: 'observed-phase-throughput',
        phase: this.data.phase,
      };
    if (snapshot.phaseEstimate === undefined) snapshot.phaseEstimate = this.currentPhaseEstimate;
    const estimates = phases.map((phase) => this.estimate(phase));
    if (estimates.every((estimate) => estimate !== undefined)) {
      // Work classes can overlap. The lower bound assumes overlap; the upper bound permits serial contention.
      snapshot.estimate = {
        lowerMs: Math.max(...estimates.map((estimate) => estimate!.lowerMs)),
        upperMs: estimates.reduce((sum, estimate) => sum + estimate!.upperMs, 0),
        scope: 'run',
        confidence: 'low',
        reason: 'observed-throughput-with-overlap-and-contention',
      };
      snapshot.estimating = false;
    }
    return sanitizeArchiveProgress(snapshot, { includeRates: true })!;
  }
  private recentThroughput(now: number): ArchiveProgressSnapshot['recentThroughput'] {
    const first = this.recentHistory[0];
    const last = this.recentHistory.at(-1);
    if (
      this.data.state !== 'running' ||
      first === undefined ||
      last === undefined ||
      this.recentHistory.length < 2 ||
      last.at - first.at < 1000 ||
      now - last.at > 30_000
    )
      return undefined;
    return {
      messages: this.recentHistory.slice(1).reduce((total, sample) => total + sample.units, 0),
      windowMs: last.at - first.at,
      observedAt: last.at,
    };
  }
  private validateUnits(units: number): void {
    if (!Number.isSafeInteger(units) || units < 0) throw new Error('invalid-progress-units');
  }
  private estimate(phase: ArchivePhase): { lowerMs: number; upperMs: number } | undefined {
    const current = this.data.phases[phase];
    if (current.total === undefined) return undefined;
    const remaining = Math.max(0, current.total - current.committed);
    if (remaining === 0) return { lowerMs: 0, upperMs: 0 };
    if (current.rates.length < 3) return undefined;
    const rates = [...current.rates].sort((a, b) => a - b);
    const slow = rates[Math.floor((rates.length - 1) * 0.2)]!;
    const fast = rates[Math.floor((rates.length - 1) * 0.8)]!;
    return {
      lowerMs: Math.round((remaining / fast) * 0.8),
      upperMs: Math.ceil((remaining / slow) * 1.25),
    };
  }
}

/** Keep at most one progress edit pending; notification failures never fail the archive job. */
export class ProgressNotifier<T> {
  private lastSent = -Infinity;
  private pending: T | undefined;
  private urgentPending = false;
  private sending: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly intervalMs = 10000,
    private readonly clock: () => number = Date.now,
  ) {
    if (!archiveNotificationSecondsSchema.safeParse(intervalMs / 1000).success)
      throw new Error('invalid-progress-notification-cadence');
  }
  async update(value: T, urgent = false): Promise<void> {
    if (this.stopped) return;
    this.pending = value;
    this.urgentPending ||= urgent;
    this.kick();
  }
  private kick(): void {
    if (this.stopped || this.sending !== undefined || this.pending === undefined) return;
    const deadline = Math.max(
      this.retryAt,
      this.urgentPending ? 0 : this.lastSent + this.intervalMs,
    );
    clearTimeout(this.timer);
    if (deadline > this.clock()) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.kick();
      }, deadline - this.clock());
      this.timer.unref();
      return;
    }
    this.sending = this.flush().finally(() => {
      this.sending = undefined;
      this.kick();
    });
    void this.sending.catch(() => undefined);
  }
  private async flush(): Promise<void> {
    while (this.pending !== undefined && !this.stopped) {
      if (
        this.clock() < this.retryAt ||
        (!this.urgentPending && this.clock() - this.lastSent < this.intervalMs)
      )
        return;
      const latest = this.pending;
      this.pending = undefined;
      this.urgentPending = false;
      this.lastSent = this.clock();
      try {
        await this.send(latest);
        this.failures = 0;
        this.retryAt = 0;
      } catch {
        this.failures += 1;
        this.retryAt = this.clock() + Math.min(30000, 5000 * 2 ** Math.min(this.failures - 1, 3));
        this.pending ??= latest;
        return;
      }
    }
  }
  /** Wait for one bounded latest-value publication; stop never leaves retry timers behind. */
  async drain(): Promise<void> {
    await this.sending;
    if (this.pending !== undefined && !this.stopped) {
      this.urgentPending = true;
      this.retryAt = 0;
      this.kick();
      await this.sending;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending = undefined;
    await this.sending;
  }
  snapshot(): { pending: number; sending: boolean; failures: number } {
    return {
      pending: this.pending === undefined ? 0 : 1,
      sending: this.sending !== undefined,
      failures: this.failures,
    };
  }
}

/** A bounded, explicitly local phase estimate does not invent a whole-history denominator. */
export class KnownPhaseEstimator {
  private completed = 0;
  private pendingUnits = 0;
  private lastSample: number;
  private readonly rates: number[];
  constructor(
    private readonly phase: ArchivePhase,
    private total: number | undefined,
    private readonly clock: () => number = Date.now,
    priorRates: readonly number[] = [],
  ) {
    this.lastSample = clock();
    this.rates = priorRates.filter((rate) => Number.isFinite(rate) && rate > 0).slice(-16);
  }
  commit(units: number): void {
    if (!Number.isSafeInteger(units) || units < 0) throw new Error('invalid-progress-units');
    this.completed += units;
    this.pendingUnits += units;
    if (this.total !== undefined && this.completed > this.total) this.total = undefined;
    const now = this.clock();
    const elapsed = now - this.lastSample;
    if (elapsed >= 1000 && this.pendingUnits > 0) {
      this.rates.push(this.pendingUnits / elapsed);
      if (this.rates.length > 16) this.rates.shift();
      this.pendingUnits = 0;
      this.lastSample = now;
    }
  }
  snapshot(): RemainingEstimate | undefined {
    if (this.total === undefined || this.rates.length < 3 || this.completed >= this.total)
      return undefined;
    const rates = [...this.rates].sort((a, b) => a - b);
    const remaining = this.total - this.completed;
    return {
      scope: 'phase',
      phase: this.phase,
      confidence: 'low',
      reason: 'currently-known-work-only',
      lowerMs: Math.round((remaining / rates[Math.floor((rates.length - 1) * 0.8)]!) * 0.8),
      upperMs: Math.ceil((remaining / rates[Math.floor((rates.length - 1) * 0.2)]!) * 1.25),
    };
  }
  speedSamples(): number[] {
    return [...this.rates];
  }
}
