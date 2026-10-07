import { lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { checkArchiveCapacity } from '../../core/archive/capacity';
import type { Connection } from 'mongoose';

interface StorageUsage {
  readonly measuredAt: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly roots: readonly string[];
}

/** Walk physical allocation, deduplicating hard links and nested roots. */
export const measureStorageRoots = async (inputs: readonly string[]): Promise<StorageUsage> => {
  if (inputs.length === 0) throw new TypeError('Archive storage roots must not be empty');
  const measuredAt = Date.now();
  const resolved = [...new Set(await Promise.all(inputs.map((path) => realpath(path))))].sort();
  const roots = resolved.filter(
    (path) => !resolved.some((other) => path !== other && path.startsWith(`${other}${sep}`)),
  );
  const seen = new Set<string>();
  let usedBytes = 0;
  let availableBytes = Number.POSITIVE_INFINITY;
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    const identity = `${stat.dev}:${stat.ino}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    usedBytes += stat.blocks * 512;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const directory = await opendir(path);
    for await (const entry of directory) await visit(join(path, entry.name));
  };
  for (const root of roots) {
    const filesystem = await statfs(root);
    availableBytes = Math.min(availableBytes, filesystem.bavail * filesystem.bsize);
    await visit(root);
  }
  return { measuredAt, usedBytes, availableBytes, roots };
};

/** Resolve managed storage without assuming the Mongo data is inside the repo. */
export const resolveArchiveStorageRoots = async (
  connection: Connection,
  additionalRoots: readonly string[],
  configuredMongoRoot?: string,
): Promise<readonly string[]> => {
  if (configuredMongoRoot !== undefined)
    return [
      resolve('.'),
      dirname(dirname(process.execPath)),
      configuredMongoRoot,
      ...additionalRoots,
    ];
  const db = connection.db;
  if (db === undefined) throw new Error('Archive storage inventory requires an open database');
  const options: unknown = await db.admin().command({ getCmdLineOpts: 1 });
  const parsed = options as { parsed?: { storage?: { dbPath?: unknown } } };
  const dbPath = parsed.parsed?.storage?.dbPath;
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new Error('MongoDB did not disclose storage.dbPath; archive capacity is unknown');
  }
  // Count the entire managed Mongo data directory conservatively, including
  // journals and databases beyond backup_server. Conda is outside many repos.
  return [resolve('.'), dirname(dirname(process.execPath)), dbPath, ...additionalRoots];
};

export class ArchiveStorageMonitor {
  private cached: StorageUsage | undefined;
  private pending: Promise<StorageUsage> | undefined;
  private reservedBytes = 0;
  private warnedAt = 0;
  private admittedBytes = 0;
  private readonly pendingAllocations = new Map<symbol, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly measure: () => Promise<StorageUsage>,
    private readonly budgetBytes: number,
    private readonly backgroundLimitBytes: number,
    private readonly reserveBytes: number,
    private readonly maxAgeMs = 30_000,
    private readonly onWarning?: (usage: StorageUsage) => void,
  ) {
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
          throw new Error('Archive capacity measurement is invalid or expired');
        this.cached = usage;
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
        void this.refresh().catch(() => undefined);
      },
      Math.max(1, Math.floor(this.maxAgeMs / 2)),
    );
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async admit(bytes: number, background: boolean, token?: symbol): Promise<StorageUsage> {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new TypeError('Invalid projected archive bytes');
    const age =
      this.cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - this.cached.measuredAt;
    if (age < 0 || age >= this.maxAgeMs) await this.refresh();
    const usage = this.cached;
    if (usage === undefined) throw new Error('Archive capacity is unknown');
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
      this.onWarning?.(usage);
    }
    if (!decision.allowed) {
      throw new Error(
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
