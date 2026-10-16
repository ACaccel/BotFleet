import { checkArchiveCapacity } from '../../../core/archive/capacity';
import { ArchiveCapacityError } from '../../../core/archive/errors';
import type { StorageUsage } from '../../../infra/archive/storage-usage';

/** Budget limits of {@link ArchiveStorageMonitor}, in bytes. */
interface ArchiveStorageLimits {
  readonly budgetBytes: number;
  readonly backgroundLimitBytes: number;
  readonly reserveBytes: number;
  /** Oldest sample admission uses without refreshing; default 30 seconds. */
  readonly maxAgeMs?: number;
}
interface ArchiveStorageHooks {
  readonly onWarning?: (usage: StorageUsage) => void;
  readonly onSample?: (usage: StorageUsage) => void;
  /** A background sample failed. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Storage admission for archive writes: a budget, a background pause threshold
 * and a reserve over host samples, charging admitted bytes until a sample that
 * started after them covers them.
 */
export class ArchiveStorageMonitor {
  private cached: StorageUsage | undefined;
  private pending: Promise<StorageUsage> | undefined;
  private reservedBytes = 0;
  private warnedAt = 0;
  private admittedBytes = 0;
  private readonly pendingAllocations = new Map<symbol, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly budgetBytes: number;
  private readonly backgroundLimitBytes: number;
  private readonly reserveBytes: number;
  private readonly maxAgeMs: number;

  public constructor(
    private readonly measure: () => Promise<StorageUsage>,
    limits: ArchiveStorageLimits,
    private readonly hooks: ArchiveStorageHooks = {},
  ) {
    const { budgetBytes, backgroundLimitBytes, reserveBytes, maxAgeMs = 30_000 } = limits;
    this.budgetBytes = budgetBytes;
    this.backgroundLimitBytes = backgroundLimitBytes;
    this.reserveBytes = reserveBytes;
    this.maxAgeMs = maxAgeMs;
    if (
      ![budgetBytes, backgroundLimitBytes, reserveBytes, maxAgeMs].every(Number.isSafeInteger) ||
      backgroundLimitBytes <= 0 ||
      backgroundLimitBytes >= budgetBytes ||
      reserveBytes <= 0 ||
      maxAgeMs <= 0 ||
      maxAgeMs > 2_147_483_647
    ) {
      throw new TypeError('Invalid archive storage budget');
    }
  }

  /** Reservations account for admitted writes until the next physical sample. */
  public async reserve(bytes: number, background: boolean): Promise<StorageUsage> {
    return this.admit(bytes, background);
  }

  /** Completed allocation stays charged until a sample starts after its completion. */
  public async withReservation<T>(
    bytes: number,
    background: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const token = Symbol('archive-allocation');
    try {
      await this.admit(bytes, background, token);
      return await operation();
    } finally {
      this.pendingAllocations.delete(token);
    }
  }

  public async refresh(): Promise<StorageUsage> {
    if (this.pending !== undefined) return this.pending;
    const admittedAtStart = this.admittedBytes;
    const pendingAtStart = [...this.pendingAllocations.values()].reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    this.pending = Promise.resolve()
      .then(() => this.measure())
      .then((usage) => {
        const age = Date.now() - usage.measuredAt;
        if (
          !Number.isSafeInteger(usage.usedBytes) ||
          usage.usedBytes < 0 ||
          !Number.isSafeInteger(usage.availableBytes) ||
          usage.availableBytes < 0 ||
          !Number.isFinite(usage.measuredAt) ||
          age < 0 ||
          age >= this.maxAgeMs
        )
          throw new ArchiveCapacityError('Archive capacity measurement is invalid or expired');
        this.cached = usage;
        this.hooks.onSample?.(usage);
        // In-flight writes may not have reached disk during this walk. New admissions
        // during a background sample also remain charged, even if they completed.
        this.reservedBytes = pendingAtStart + this.admittedBytes - admittedAtStart;
        return usage;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(
      () => {
        void this.refresh().catch((error: unknown) => this.hooks.onError?.(error));
      },
      Math.max(1, Math.floor(this.maxAgeMs / 2)),
    );
    this.timer.unref();
  }

  /** Stops sampling and waits for a sample still running. */
  public async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending?.catch(() => undefined);
  }

  private async admit(bytes: number, background: boolean, token?: symbol): Promise<StorageUsage> {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new TypeError('Invalid projected archive bytes');
    const age =
      this.cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - this.cached.measuredAt;
    // Writers do not wait for a sample while the previous one is less than two ages
    // old: the refresh runs in the background, and every byte admitted since that
    // sample started stays charged. Older or missing samples are awaited.
    if (age >= this.maxAgeMs && age < this.maxAgeMs * 2)
      void this.refresh().catch((error: unknown) => this.hooks.onError?.(error));
    else if (age < 0 || age >= this.maxAgeMs) await this.refresh();
    const usage = this.cached;
    if (usage === undefined) throw new ArchiveCapacityError('Archive capacity is unknown');
    const projected = this.reservedBytes + bytes;
    const decision = checkArchiveCapacity(
      {
        projectBytes: usage.usedBytes,
        freeBytes: usage.availableBytes,
        projectedBytes: bytes,
        reservedBytes: this.reservedBytes + this.reserveBytes,
        budgetBytes: this.budgetBytes,
        pauseBytes: this.backgroundLimitBytes,
        warningBytes: Math.floor(this.budgetBytes * 0.7),
        minimumFreeBytes: 0,
      },
      background ? 'bulk' : 'live',
    );
    if (decision.warning && this.warnedAt !== usage.measuredAt) {
      this.warnedAt = usage.measuredAt;
      this.hooks.onWarning?.(usage);
    }
    if (!decision.allowed) {
      throw new ArchiveCapacityError(
        background
          ? 'Archive backfill paused: storage headroom exhausted'
          : 'Archive capture blocked: storage headroom exhausted',
      );
    }
    this.reservedBytes = projected;
    this.admittedBytes += bytes;
    if (token !== undefined) this.pendingAllocations.set(token, bytes);
    return usage;
  }
}
