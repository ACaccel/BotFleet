import { ARCHIVE_LIMITS } from '../../../core/archive/limits';

/** Stages the owner records; their timings overlap, so they never sum to wall time. */
export const ARCHIVE_PIPELINE_STAGES = [
  'fetch',
  'normalize',
  'write',
  'reactions',
  'checkpoint',
  'process',
] as const;
export type PipelineStage = (typeof ARCHIVE_PIPELINE_STAGES)[number];
export interface PipelineStageTotals {
  count: number;
  durationMs: number;
  bytes: number;
}
type PipelineLane = 'history' | 'reactions';
interface PipelineReservation {
  (): void;
  /** Returns confirmed unused capacity to the lane. */
  shrink(bytes: number): void;
  /**
   * Extends the reservation to `bytes` when a response turns out larger than its
   * estimate. If the lane cannot take it at once, the reservation gives back what it
   * holds and waits ahead of new requests for the whole amount, so growers never hold
   * bytes while waiting on each other.
   */
  grow(bytes: number, signal?: AbortSignal): Promise<void>;
}
/** The bytes an admitted reservation currently accounts for. */
interface Holding {
  bytes: number;
  readonly lane: PipelineLane;
  released: boolean;
}
interface Waiter {
  readonly bytes: number;
  readonly lane: PipelineLane;
  readonly queuedAt: number;
  /** A grower: admitted before new requests, and the lane waits for it. */
  readonly urgent: boolean;
  admit(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  cancel?: () => void;
}

export interface PipelineSnapshot {
  readonly capacityBytes: number;
  readonly reservedBytes: number;
  readonly historyCapacityBytes: number;
  readonly historyReservedBytes: number;
  readonly reactionCapacityBytes: number;
  readonly reactionReservedBytes: number;
  readonly peakReservedBytes: number;
  readonly waiting: number;
  readonly historyWaiting: number;
  readonly reactionWaiting: number;
  readonly queueWaitMs: number;
  readonly stages: Readonly<Record<PipelineStage, PipelineStageTotals>>;
}

/** One owner shares this budget across history pages and independently staged reaction work. */
export class ArchivePipelineBudget {
  private reserved = 0;
  private historyReserved = 0;
  private reactionReserved = 0;
  private readonly historyCapacity: number;
  private readonly reactionCapacity: number;
  private peak = 0;
  private queueWaitMs = 0;
  private readonly waiting: Waiter[] = [];
  private readonly stages = Object.fromEntries(
    ARCHIVE_PIPELINE_STAGES.map((stage) => [stage, { count: 0, durationMs: 0, bytes: 0 }]),
  ) as Record<PipelineStage, PipelineStageTotals>;

  /** `maxWaiting` bounds queued reservations; the owner sizes it from its reader count. */
  constructor(
    private readonly capacityBytes: number = ARCHIVE_LIMITS.pipelineBytes,
    private readonly maxWaiting: number = ARCHIVE_LIMITS.queuedFloor,
  ) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 2)
      throw new Error('invalid-archive-pipeline-budget');
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1)
      throw new Error('invalid-archive-pipeline-queue-limit');
    this.reactionCapacity = Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(capacityBytes / 8)));
    this.historyCapacity = capacityBytes - this.reactionCapacity;
  }

  reserve(
    bytes: number,
    signal?: AbortSignal,
    lane: PipelineLane = 'history',
  ): Promise<PipelineReservation> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.capacityOf(lane))
      return Promise.reject(new Error('archive-pipeline-item-too-large'));
    if (signal?.aborted) return Promise.reject(new Error('archive-pipeline-cancelled'));
    if (this.waiting.length >= this.maxWaiting)
      return Promise.reject(new Error('archive-pipeline-queue-full'));
    return new Promise((resolve, reject) =>
      this.enqueue({
        bytes,
        lane,
        signal,
        urgent: false,
        queuedAt: Date.now(),
        admit: () => resolve(this.handle({ bytes, lane, released: false })),
        reject,
      }),
    );
  }

  record(stage: PipelineStage, durationMs: number, bytes = 0): void {
    const value = this.stages[stage];
    value.count += 1;
    value.durationMs += Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    value.bytes += Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  }

  snapshot(): PipelineSnapshot {
    return {
      capacityBytes: this.capacityBytes,
      historyCapacityBytes: this.historyCapacity,
      historyReservedBytes: this.historyReserved,
      reactionCapacityBytes: this.reactionCapacity,
      reactionReservedBytes: this.reactionReserved,
      reservedBytes: this.reserved,
      peakReservedBytes: this.peak,
      waiting: this.waiting.length,
      historyWaiting: this.waiting.filter((item) => item.lane === 'history').length,
      reactionWaiting: this.waiting.filter((item) => item.lane === 'reactions').length,
      queueWaitMs: this.queueWaitMs,
      stages: structuredClone(this.stages),
    };
  }

  private capacityOf(lane: PipelineLane): number {
    return lane === 'history' ? this.historyCapacity : this.reactionCapacity;
  }
  private reservedIn(lane: PipelineLane): number {
    return lane === 'history' ? this.historyReserved : this.reactionReserved;
  }
  private take(lane: PipelineLane, bytes: number): void {
    this.reserved += bytes;
    if (lane === 'history') this.historyReserved += bytes;
    else this.reactionReserved += bytes;
    this.peak = Math.max(this.peak, this.reserved);
  }
  private free(lane: PipelineLane, bytes: number): void {
    this.reserved -= bytes;
    if (lane === 'history') this.historyReserved -= bytes;
    else this.reactionReserved -= bytes;
    this.pump();
  }

  private enqueue(waiter: Waiter): void {
    if (waiter.signal !== undefined) {
      waiter.cancel = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          waiter.reject(new Error('archive-pipeline-cancelled'));
          this.pump();
        }
      };
      waiter.signal.addEventListener('abort', waiter.cancel, { once: true });
    }
    // Growers queue behind earlier growers but ahead of every new request.
    const firstNew = this.waiting.findIndex((item) => !item.urgent);
    if (waiter.urgent && firstNew >= 0) this.waiting.splice(firstNew, 0, waiter);
    else this.waiting.push(waiter);
    this.pump();
  }

  private handle(holding: Holding): PipelineReservation {
    return Object.assign(
      () => {
        if (holding.released) return;
        holding.released = true;
        const bytes = holding.bytes;
        holding.bytes = 0;
        this.free(holding.lane, bytes);
      },
      {
        shrink: (bytes: number): void => {
          if (holding.released) throw new Error('archive-pipeline-reservation-released');
          if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > holding.bytes)
            throw new Error('invalid-archive-pipeline-shrink');
          const reclaimed = holding.bytes - bytes;
          holding.bytes = bytes;
          if (reclaimed > 0) this.free(holding.lane, reclaimed);
        },
        grow: (bytes: number, signal?: AbortSignal): Promise<void> =>
          this.grow(holding, bytes, signal),
      },
    );
  }

  private grow(holding: Holding, bytes: number, signal?: AbortSignal): Promise<void> {
    const { lane } = holding;
    if (holding.released) return Promise.reject(new Error('archive-pipeline-reservation-released'));
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.capacityOf(lane))
      return Promise.reject(new Error('archive-pipeline-item-too-large'));
    if (bytes <= holding.bytes) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('archive-pipeline-cancelled'));
    const growerWaiting = this.waiting.some((item) => item.urgent && item.lane === lane);
    if (!growerWaiting && this.reservedIn(lane) - holding.bytes + bytes <= this.capacityOf(lane)) {
      this.take(lane, bytes - holding.bytes);
      holding.bytes = bytes;
      return Promise.resolve();
    }
    const held = holding.bytes;
    holding.bytes = 0;
    return new Promise((resolve, reject) => {
      this.enqueue({
        bytes,
        lane,
        signal,
        urgent: true,
        queuedAt: Date.now(),
        admit: () => {
          if (holding.released) this.free(lane, bytes);
          else holding.bytes = bytes;
          resolve();
        },
        reject,
      });
      // Given back only after the grower is queued, so no new request takes it first.
      if (held > 0) this.free(lane, held);
    });
  }

  private pump(): void {
    for (;;) {
      // A waiting grower holds its lane, so smaller new requests cannot starve it.
      const blocked = new Set<PipelineLane>();
      const index = this.waiting.findIndex((item) => {
        if (blocked.has(item.lane)) return false;
        if (this.reservedIn(item.lane) + item.bytes <= this.capacityOf(item.lane)) return true;
        if (item.urgent) blocked.add(item.lane);
        return false;
      });
      if (index < 0) return;
      const item = this.waiting.splice(index, 1)[0]!;
      if (item.cancel !== undefined) item.signal?.removeEventListener('abort', item.cancel);
      this.take(item.lane, item.bytes);
      this.queueWaitMs += Math.max(0, Date.now() - item.queuedAt);
      item.admit();
    }
  }
}
