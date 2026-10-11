import { ArchiveCapacityError } from '../../core/archive/errors';
import { lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Connection } from 'mongoose';
import { serverDataPath } from '../mongo/admin';

export interface StorageUsage {
  /** When the sample started; it bounds the age the monitor accepts. */
  readonly measuredAt: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly roots: readonly string[];
  /** When the reused size of the stable roots was walked (`ArchiveStorageSampler`). */
  readonly stableMeasuredAt?: number;
}

/** A file or directory removed while it is walked, such as a dropped collection's file. */
const isVanished = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const canonicalRoots = async (inputs: readonly string[]): Promise<string[]> => {
  const resolved = [...new Set(await Promise.all(inputs.map((path) => realpath(path))))].sort();
  return resolved.filter(
    (path) => !resolved.some((other) => path !== other && path.startsWith(`${other}${sep}`)),
  );
};

const inside = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}${sep}`));

/** The smallest free space of the filesystems holding `roots`. */
const availableBytes = async (roots: readonly string[]): Promise<number> => {
  let available = Number.POSITIVE_INFINITY;
  for (const root of roots) {
    const filesystem = await statfs(root);
    available = Math.min(available, filesystem.bavail * filesystem.bsize);
  }
  return available;
};

/**
 * Walk physical allocation, deduplicating hard links and nested roots. Paths at or
 * below `exclude` are skipped; entries removed during the walk count as gone.
 */
export const measureStorageRoots = async (
  inputs: readonly string[],
  exclude: readonly string[] = [],
): Promise<StorageUsage> => {
  if (inputs.length === 0) throw new TypeError('Archive storage roots must not be empty');
  const measuredAt = Date.now();
  const skipped = await Promise.all(
    exclude.map((path) => realpath(path).catch(() => resolve(path))),
  );
  const canonical = await canonicalRoots(inputs);
  const roots = canonical.filter((root) => !inside(root, skipped));
  const seen = new Set<string>();
  let usedBytes = 0;
  const visit = async (path: string, root: boolean): Promise<void> => {
    if (inside(path, skipped)) return;
    try {
      const stat = await lstat(path);
      const identity = `${stat.dev}:${stat.ino}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      usedBytes += stat.blocks * 512;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const directory = await opendir(path);
      for await (const entry of directory) await visit(join(path, entry.name), false);
    } catch (error) {
      if (root || !isVanished(error)) throw error;
    }
  };
  for (const root of roots) await visit(root, true);
  return { measuredAt, usedBytes, availableBytes: await availableBytes(canonical), roots };
};

/** Storage the archive budget covers, split by how often its size changes. */
interface ArchiveStorageRoots {
  /** The project, the Node runtime and `storage.additional_roots`: sampled rarely. */
  readonly stable: readonly string[];
  /** The MongoDB data directory: sampled every time. */
  readonly live: readonly string[];
}

/** Resolve managed storage without assuming the Mongo data is inside the repo. */
export const resolveArchiveStorageRoots = async (
  connection: Connection,
  additionalRoots: readonly string[],
  configuredMongoRoot?: string,
): Promise<ArchiveStorageRoots> => {
  const stable = [resolve('.'), dirname(dirname(process.execPath)), ...additionalRoots];
  if (configuredMongoRoot !== undefined) return { stable, live: [configuredMongoRoot] };
  const db = connection.db;
  if (db === undefined) throw new Error('Archive storage inventory requires an open database');
  const dbPath = await serverDataPath(db);
  if (dbPath === undefined) {
    throw new ArchiveCapacityError(
      'MongoDB did not disclose storage.dbPath; archive capacity is unknown',
    );
  }
  // Count the entire managed Mongo data directory conservatively, including
  // journals and databases beyond backup_server. Conda is outside many repos.
  return { stable, live: [dbPath] };
};

/** How long a sample of the stable roots is reused before it is walked again. */
export const ARCHIVE_STABLE_STORAGE_MAX_AGE_MS = 600_000;

interface ArchiveStorageSamplerOptions {
  readonly resolveRoots: () => Promise<ArchiveStorageRoots>;
  /** Default {@link ARCHIVE_STABLE_STORAGE_MAX_AGE_MS}. */
  readonly stableMaxAgeMs?: number;
  /**
   * Once a sample reaches this many bytes, the stable roots are walked on every
   * sample, so their growth cannot go unnoticed near the budget.
   */
  readonly exactAboveBytes?: number;
  readonly now?: () => number;
}

/**
 * Measures the archive's storage roots for the archive worker's storage monitor. The MongoDB
 * data directory (live) is walked on every sample. The project, runtime and
 * additional roots (stable) change rarely, through deployments, logs and
 * attachment archives; their size is reused for `stableMaxAgeMs` and walked again,
 * before the sample completes, once it is older or the last sample reached
 * `exactAboveBytes`. Free space is read for every root each time.
 */
export class ArchiveStorageSampler {
  private readonly stableMaxAgeMs: number;
  private roots: ArchiveStorageRoots | undefined;
  private stable: { readonly usedBytes: number; readonly measuredAt: number } | undefined;
  private lastUsedBytes = 0;

  public constructor(private readonly options: ArchiveStorageSamplerOptions) {
    this.stableMaxAgeMs = options.stableMaxAgeMs ?? ARCHIVE_STABLE_STORAGE_MAX_AGE_MS;
    if (!Number.isSafeInteger(this.stableMaxAgeMs) || this.stableMaxAgeMs <= 0)
      throw new TypeError('Invalid archive storage sample age');
  }

  public async sample(): Promise<StorageUsage> {
    const roots = (this.roots ??= await this.options.resolveRoots());
    const now = this.options.now ?? Date.now;
    let stable = this.stable;
    const age = stable === undefined ? Number.POSITIVE_INFINITY : now() - stable.measuredAt;
    if (
      stable === undefined ||
      age < 0 ||
      age >= this.stableMaxAgeMs ||
      (this.options.exactAboveBytes !== undefined &&
        this.lastUsedBytes >= this.options.exactAboveBytes)
    )
      stable = await this.walkStable(roots, now());
    const measured = await measureStorageRoots(roots.live);
    const usedBytes = stable.usedBytes + measured.usedBytes;
    this.lastUsedBytes = usedBytes;
    return {
      measuredAt: measured.measuredAt,
      usedBytes,
      availableBytes: Math.min(
        measured.availableBytes,
        roots.stable.length === 0
          ? Number.POSITIVE_INFINITY
          : await availableBytes(await canonicalRoots(roots.stable)),
      ),
      roots: [...roots.stable, ...roots.live],
      stableMeasuredAt: stable.measuredAt,
    };
  }

  /** The live roots are excluded so data inside the project is counted once, live. */
  private async walkStable(
    roots: ArchiveStorageRoots,
    measuredAt: number,
  ): Promise<{ readonly usedBytes: number; readonly measuredAt: number }> {
    const canonicalLive = await canonicalRoots(roots.live);
    const stable = (await canonicalRoots(roots.stable)).filter(
      (root) => !inside(root, canonicalLive),
    );
    const usedBytes =
      stable.length === 0 ? 0 : (await measureStorageRoots(stable, canonicalLive)).usedBytes;
    this.stable = { usedBytes, measuredAt };
    return this.stable;
  }
}
