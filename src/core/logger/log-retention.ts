/**
 * Age-based retention for the file log tree.
 *
 * Several bot processes share one log root and each prunes it on its own
 * schedule, so a pass must be idempotent and tolerate another process
 * deleting the same file (`ENOENT`) mid-walk. Age is read from the date
 * embedded in the file name, never from mtime: a host migration resets
 * every mtime to the copy time.
 *
 * Only two name shapes are ever deleted: the sink's `<YYYY-MM-DD>.log` and
 * the msg-archive transcript's `<prefix>-<YYYY-MM-DD>_<HH-MM-SS>.log`.
 * Anything else under the root (an operator's notes, `error.log`, a rotated
 * archive) is left alone. Only regular files are unlinked and symlinks are
 * neither followed nor removed, so a link cannot make the pruner reach
 * outside the tree.
 *
 * Failures never throw out of this module: the logger is the thing being
 * maintained, so they go to the caller's `onFailure` and the bot keeps
 * running.
 */
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_LOG_RETENTION_DAYS = 60;
/** Upper bound that keeps the cutoff arithmetic far from `Date` limits. */
const MAX_LOG_RETENTION_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

const SINK_FILE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
const BACKUP_FILE = /^.+-(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}\.log$/;

/**
 * Parse a retention setting. Digits only (no sign, decimal, blank or
 * whitespace) so a typo never silently becomes `0`, which disables
 * retention. Returns `undefined` when the value is invalid.
 */
export const parseLogRetentionDays = (raw: string): number | undefined => {
  if (!/^\d+$/.test(raw)) return undefined;
  const days = Number(raw);
  return days <= MAX_LOG_RETENTION_DAYS ? days : undefined;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in the operator's local timezone, matching the sink's rotation. */
const localDayKey = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Extract the `YYYY-MM-DD` key a prunable file name encodes, or
 * `undefined` for any other name. A syntactically matching but
 * impossible date (month 13, Feb 30) is treated as non-matching so a
 * stray file is never deleted on a guess.
 */
const dayKeyOf = (name: string): string | undefined => {
  const m = SINK_FILE.exec(name) ?? BACKUP_FILE.exec(name);
  if (m === null) return undefined;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const probe = new Date(Number(y), Number(mo) - 1, Number(d));
  const key = `${y}-${mo}-${d}`;
  return localDayKey(probe) === key ? key : undefined;
};

export interface PruneResult {
  readonly deleted: number;
  readonly failures: number;
  /** First failure of the pass, so a persistent fault is reported once, not per file. */
  readonly firstFailure?: { readonly path: string; readonly error: unknown };
}

interface PruneOptions {
  readonly rootDir: string;
  /** Files dated more than this many local days ago are deleted. */
  readonly retentionDays: number;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** Polled between entries so a closed sink abandons a long pass. */
  readonly isCancelled?: () => boolean;
}

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;

/**
 * One retention pass over `rootDir`. A file dated exactly
 * `retentionDays` local days ago is kept; the day before it is the first
 * to go. Directories this pass leaves empty are removed (never the
 * root); losing the race to a writer that recreates one is harmless
 * because the sink reopens a failed target after its cooldown.
 */
export const pruneLogs = async (options: PruneOptions): Promise<PruneResult> => {
  const today = (options.now ?? ((): Date => new Date()))();
  const cutoffKey = localDayKey(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - options.retentionDays),
  );
  let deleted = 0;
  let failures = 0;
  let firstFailure: { path: string; error: unknown } | undefined;
  const cancelled = (): boolean => options.isCancelled?.() === true;

  const fail = (path: string, error: unknown): void => {
    failures += 1;
    firstFailure ??= { path, error };
  };

  /** Returns true when `dir` was emptied by this pass and removed. */
  const walk = async (dir: string, isRoot: boolean): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      // A missing root (nothing logged yet) or a directory another
      // process just removed is not a failure.
      if (errorCode(err) !== 'ENOENT') fail(dir, err);
      return false;
    }
    let remaining = entries.length;
    for (const entry of entries) {
      if (cancelled()) return false;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(path, false)) remaining -= 1;
      } else if (entry.isFile()) {
        const key = dayKeyOf(entry.name);
        if (key === undefined || key >= cutoffKey) continue;
        try {
          await unlink(path);
          deleted += 1;
          remaining -= 1;
        } catch (err: unknown) {
          if (errorCode(err) === 'ENOENT') {
            remaining -= 1;
          } else {
            fail(path, err);
          }
        }
      }
    }
    if (isRoot || remaining > 0 || cancelled()) return false;
    try {
      await rmdir(dir);
      return true;
    } catch (err: unknown) {
      const code = errorCode(err);
      // ENOTEMPTY / EEXIST: a writer or another pruner got there first.
      if (code === 'ENOENT') return true;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') fail(dir, err);
      return false;
    }
  };

  await walk(options.rootDir, true);
  return firstFailure === undefined ? { deleted, failures } : { deleted, failures, firstFailure };
};

export interface LogRetentionOptions {
  readonly rootDir: string;
  readonly retentionDays: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Called at most once per pass, with the first failure and the pass's total. */
  readonly onFailure: (path: string, error: unknown, failures: number) => void;
}

export interface LogRetention {
  /** Stop the schedule and abandon any in-flight pass. Idempotent. */
  readonly stop: () => void;
}

/**
 * Run a pass now and then every `intervalMs` (default 24h). The timer is
 * `unref`'d so retention never keeps the process alive, and passes never
 * overlap.
 */
export const startLogRetention = (options: LogRetentionOptions): LogRetention => {
  let stopped = false;
  let running = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await pruneLogs({
        rootDir: options.rootDir,
        retentionDays: options.retentionDays,
        ...(options.now !== undefined ? { now: options.now } : {}),
        isCancelled: () => stopped,
      });
      if (result.firstFailure !== undefined) {
        options.onFailure(result.firstFailure.path, result.firstFailure.error, result.failures);
      }
    } catch (err: unknown) {
      options.onFailure(options.rootDir, err, 1);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), options.intervalMs ?? DAY_MS);
  timer.unref();

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
