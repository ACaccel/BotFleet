import { ARCHIVE_LIMITS } from '../../../core/archive/limits';

type PipelineStage =
  | 'fetch'
  | 'normalize'
  | 'write'
  | 'reactions'
  | 'checkpoint'
  | 'process'
  | 'journal'
  | 'writeVerify';
interface PipelineReservation {
  (): void;
  shrink(bytes: number): void;
}

interface Reservation {
  bytes: number;
  resolve(release: PipelineReservation): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  cancel?: () => void;
  queuedAt: number;
  lane: 'history' | 'reactions';
}

export interface PipelineSnapshot {
  readonly capacityBytes: number;
  readonly reservedBytes: number;
  readonly historyCapacityBytes: number;
  readonly reactionCapacityBytes: number;
  readonly peakReservedBytes: number;
  readonly waiting: number;
  readonly queueWaitMs: number;
  readonly stages: Readonly<
    Record<PipelineStage, { count: number; durationMs: number; bytes: number }>
  >;
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
  private readonly waiting: Reservation[] = [];
  private readonly stages: Record<
    PipelineStage,
    { count: number; durationMs: number; bytes: number }
  > = {
    fetch: { count: 0, durationMs: 0, bytes: 0 },
    normalize: { count: 0, durationMs: 0, bytes: 0 },
    write: { count: 0, durationMs: 0, bytes: 0 },
    reactions: { count: 0, durationMs: 0, bytes: 0 },
    checkpoint: { count: 0, durationMs: 0, bytes: 0 },
    process: { count: 0, durationMs: 0, bytes: 0 },
    journal: { count: 0, durationMs: 0, bytes: 0 },
    writeVerify: { count: 0, durationMs: 0, bytes: 0 },
  };

  constructor(private readonly capacityBytes: number = ARCHIVE_LIMITS.pipelineBytes) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 2)
      throw new Error('invalid-archive-pipeline-budget');
    this.reactionCapacity = Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(capacityBytes / 8)));
    this.historyCapacity = capacityBytes - this.reactionCapacity;
  }

  reserve(
    bytes: number,
    signal?: AbortSignal,
    lane: 'history' | 'reactions' = 'history',
  ): Promise<PipelineReservation> {
    const capacity = lane === 'history' ? this.historyCapacity : this.reactionCapacity;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > capacity)
      return Promise.reject(new Error('archive-pipeline-item-too-large'));
    if (signal?.aborted) return Promise.reject(new Error('archive-pipeline-cancelled'));
    if (this.waiting.length >= 128) return Promise.reject(new Error('archive-pipeline-queue-full'));
    return new Promise((resolve, reject) => {
      const item: Reservation = { bytes, signal, resolve, reject, queuedAt: Date.now(), lane };
      if (signal !== undefined) {
        item.cancel = () => {
          const index = this.waiting.indexOf(item);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            reject(new Error('archive-pipeline-cancelled'));
            this.pump();
          }
        };
        signal.addEventListener('abort', item.cancel, { once: true });
      }
      this.waiting.push(item);
      this.pump();
    });
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
      reactionCapacityBytes: this.reactionCapacity,
      reservedBytes: this.reserved,
      peakReservedBytes: this.peak,
      waiting: this.waiting.length,
      queueWaitMs: this.queueWaitMs,
      stages: structuredClone(this.stages),
    };
  }

  private pump(): void {
    while (this.waiting.length > 0) {
      const index = this.waiting.findIndex((item) =>
        item.lane === 'history'
          ? this.historyReserved + item.bytes <= this.historyCapacity
          : this.reactionReserved + item.bytes <= this.reactionCapacity,
      );
      if (index < 0) return;
      const item = this.waiting.splice(index, 1)[0]!;
      if (item.cancel !== undefined) item.signal?.removeEventListener('abort', item.cancel);
      this.reserved += item.bytes;
      if (item.lane === 'history') this.historyReserved += item.bytes;
      else this.reactionReserved += item.bytes;
      this.peak = Math.max(this.peak, this.reserved);
      this.queueWaitMs += Math.max(0, Date.now() - item.queuedAt);
      let released = false;
      const free = (bytes: number): void => {
        this.reserved -= bytes;
        if (item.lane === 'history') this.historyReserved -= bytes;
        else this.reactionReserved -= bytes;
        this.pump();
      };
      const release: PipelineReservation = Object.assign(
        () => {
          if (released) return;
          released = true;
          free(item.bytes);
        },
        {
          shrink: (bytes: number): void => {
            if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > item.bytes)
              throw new Error('invalid-archive-pipeline-shrink');
            if (released) throw new Error('archive-pipeline-reservation-released');
            const reclaimed = item.bytes - bytes;
            item.bytes = bytes;
            if (reclaimed > 0) free(reclaimed);
          },
        },
      );
      item.resolve(release);
    }
  }
}
