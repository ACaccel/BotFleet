import type { ArchiveGapReason } from './progress';

/** Delivery bookkeeping shared by both notice kinds. */
interface ArchiveNoticeDelivery {
  readonly createdAt: number;
  readonly deliveredAt?: number;
  /** Failed sends so far and when the next may be tried. */
  readonly attempts?: number;
  readonly retryAt?: number;
  /** Set when Discord refused permanently (missing channel or access); never retried. */
  readonly abandonedAt?: number;
}
/**
 * A periodic-health message for the debug channel, persisted until delivered. A
 * newer notice replaces an undelivered one: a recovery raised before its failing
 * notice was sent supersedes it.
 */
export type ArchiveScheduleNotice =
  | (ArchiveNoticeDelivery & {
      readonly kind: 'failing';
      /** Consecutive failed passes when the notice was raised. */
      readonly failures: number;
      /** Reason category of the last failure. */
      readonly reason: ArchiveGapReason;
    })
  | (ArchiveNoticeDelivery & {
      readonly kind: 'recovered';
      /** Consecutive failures that preceded the recovery. */
      readonly failures: number;
    });

export interface ArchiveSchedule {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly nextRunAt: number | null;
  readonly running: boolean;
  readonly revision: number;
  readonly pauseVersion: number;
  /** Consecutive passes that ended failed; a complete pass resets it. */
  readonly failureStreak?: number;
  /** A failing notice was raised and no complete pass has followed it yet. */
  readonly alerted?: boolean;
  readonly lastCompletedAt?: number;
  readonly lastFailureReason?: ArchiveGapReason;
  readonly notice?: ArchiveScheduleNotice;
}

/** An operator's schedule change; omitted settings stay as saved. */
export interface ArchiveScheduleChange {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
}

/**
 * How a pass affects schedule health: `failure` for a pass that ended with
 * blocking failures, threw, or could not start because the guild is in
 * capture-only mode; `success` for a complete pass (known gaps allowed);
 * `neutral` for interrupted passes.
 */
export type ArchivePassHealth =
  | { readonly kind: 'success' }
  | { readonly kind: 'failure'; readonly reason: ArchiveGapReason }
  | { readonly kind: 'neutral' };

/** Base delay before an interrupted, skipped or failed periodic pass is retried. */
export const ARCHIVE_PERIODIC_RETRY_DELAY_MS = 60_000;
/** Backoff doubling stops here; the result already exceeds the one-week interval limit. */
const MAX_BACKOFF_EXPONENT = 14;

/**
 * How a periodic pass ended:
 * - `complete` / `partial`: the scan reached its end (partial = blocking failures).
 * - `interrupted`: paused, preempted, cancelled or shut down before its end.
 * - `skipped`: the worker could not start the scan.
 * - `failed`: the pass threw; `consecutiveFailures` counts this one (at least 1).
 */
export type ArchivePassOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'partial' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly consecutiveFailures: number };

/**
 * Delay before the next pass, or `undefined` for the full interval. `finish` caps
 * every delay at the interval. Failed passes back off exponentially.
 */
export function archiveRetryDelay(outcome: ArchivePassOutcome): number | undefined {
  switch (outcome.kind) {
    case 'complete':
    case 'partial':
      return undefined;
    case 'interrupted':
    case 'skipped':
      return ARCHIVE_PERIODIC_RETRY_DELAY_MS;
    case 'failed': {
      const exponent = Math.min(Math.max(outcome.consecutiveFailures, 1) - 1, MAX_BACKOFF_EXPONENT);
      return ARCHIVE_PERIODIC_RETRY_DELAY_MS * 2 ** exponent;
    }
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unknown archive pass outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}
