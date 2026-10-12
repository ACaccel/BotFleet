import { ArchiveBackpressureError, ArchiveCapacityError } from '../../../core/archive/errors';
import { classifyArchiveInboxFailure } from './inbox-failure';
import { ArchiveJobStoppedError } from './job-cancellation';
import { ArchiveScanInterruptedError, isProgrammerError } from './worker-context';

/**
 * Why one source's history scan failed:
 * - `stopped`: a stop request, shutdown, pause or preemption; not a failure.
 * - `transient`: Discord 5xx, 429 or timeouts, dropped connections, database
 *   timeouts or network errors, or a full in-process queue; the source can run again
 *   from its checkpoint.
 * - `capacity`: storage pressure, which pauses the whole scan.
 * - `inaccessible`: the source was deleted or its access was lost.
 * - `defect`: a programmer error or an invalid response; retrying cannot help.
 */
export type ArchiveSourceFailure = 'stopped' | 'transient' | 'capacity' | 'inaccessible' | 'defect';

/** Classifies a failed source scan; `signal` is the scan's stop, pause and shutdown signal. */
export const classifyArchiveSourceFailure = (
  error: unknown,
  signal: AbortSignal,
): ArchiveSourceFailure => {
  if (
    signal.aborted ||
    error instanceof ArchiveJobStoppedError ||
    error instanceof ArchiveScanInterruptedError
  )
    return 'stopped';
  if (isProgrammerError(error)) return 'defect';
  const failure = classifyArchiveInboxFailure(error);
  switch (failure.kind) {
    case 'inaccessible':
      return 'inaccessible';
    case 'capacity':
      return hasCause(error, ArchiveBackpressureError) && !hasCause(error, ArchiveCapacityError)
        ? 'transient'
        : 'capacity';
    case 'transient':
      return 'transient';
    case 'retry':
      return 'defect';
    default: {
      const unreachable: never = failure;
      throw new TypeError(`Unhandled archive source failure ${String(unreachable)}`);
    }
  }
};

const hasCause = (error: unknown, type: abstract new (...args: never[]) => Error): boolean => {
  for (
    let current = error, depth = 0;
    current !== undefined && current !== null && depth < 8;
    current = (current as { cause?: unknown }).cause, depth += 1
  )
    if (current instanceof type) return true;
  return false;
};

/** In-sweep retries of a transiently failing source. */
export interface ArchiveSourceRetryPolicy {
  /** Attempts in total, the first one included. */
  readonly attempts: number;
  /** Wait before the second attempt; it doubles per attempt up to `maxMs`. */
  readonly baseMs: number;
  readonly maxMs: number;
}

export const ARCHIVE_SOURCE_RETRY: ArchiveSourceRetryPolicy = {
  attempts: 5,
  baseMs: 5_000,
  maxMs: 120_000,
};

/** The wait after the given failed attempt (1-based). */
export const archiveSourceRetryDelay = (
  failedAttempts: number,
  policy: ArchiveSourceRetryPolicy,
): number =>
  Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(Math.max(0, failedAttempts - 1), 20));
