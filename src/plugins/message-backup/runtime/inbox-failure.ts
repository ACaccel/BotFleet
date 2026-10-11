import { ArchiveBackpressureError, ArchiveCapacityError } from '../../../core/archive/errors';
import { DatabaseError } from '../../../core/errors/external-service-error';
import { databaseErrorFrom, isTransient } from '../../../persistence/error-translator';
import { isForbiddenDiscordError } from '../flow/discovery';

/** Counted failures after which an inbox event is dead-lettered instead of retried. */
export const ARCHIVE_INBOX_MAX_ATTEMPTS = 10;
/**
 * Consecutive claims that ended without a recorded outcome (a crash or an expired
 * lease mid-apply). Any recorded outcome resets the count, so waits do not add up.
 */
export const ARCHIVE_INBOX_MAX_CLAIMS = 50;
/** Capacity pressure is not the event's fault; it waits without consuming attempts. */
const ARCHIVE_INBOX_CAPACITY_DELAY_MS = 300_000;
/** Transient transport or database failures retry uncounted until this long after the first failure. */
export const ARCHIVE_INBOX_TRANSIENT_WINDOW_MS = 86_400_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
const MAX_CAUSE_DEPTH = 8;

export type ArchiveInboxFailure =
  /** The source is gone or unreadable; retrying cannot succeed. */
  | {
      readonly kind: 'inaccessible';
      readonly access: 'denied' | 'deleted';
      readonly reason: string;
    }
  /** Storage pressure or a full in-process admission queue. */
  | { readonly kind: 'capacity' }
  /** Discord 5xx/429, timeouts, dropped connections or transient database errors. */
  | { readonly kind: 'transient' }
  /** Anything else: counted, backed off and eventually dead-lettered. */
  | { readonly kind: 'retry' };

export type ArchiveInboxDecision =
  /** Terminal: record the coverage gap and acknowledge. */
  | {
      readonly kind: 'gap';
      readonly access: 'denied' | 'deleted';
      readonly reason: string;
    }
  | {
      readonly kind: 'defer';
      readonly retryAt: number;
      readonly attempts: number;
      readonly firstFailedAt?: number;
    }
  | { readonly kind: 'dead'; readonly attempts: number; readonly firstFailedAt?: number };

const transientCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The error and its `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (
    let current = error;
    current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH;
    current = field(current, 'cause')
  )
    chain.push(current);
  return chain;
}

function isTransientFailure(error: unknown): boolean {
  const status = field(error, 'status');
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  const name = field(error, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = field(error, 'code');
  if (typeof code === 'string' && transientCodes.has(code)) return true;
  if (error instanceof DatabaseError) return isTransient(error);
  return (
    error instanceof Error &&
    isTransient(databaseErrorFrom(error, { operation: 'ArchiveWorker.reduceInbox' }))
  );
}

/**
 * Classifies a failed live reconciliation, walking the `cause` chain so wrapped
 * failures (for example an incomplete reaction refresh) keep their Discord code.
 * Unknown Message (10008) never reaches here: the reducer tombstones it. An
 * HTTP-only 403 without a Discord code (for example from a proxy) is not proof of
 * missing access and is retried.
 */
export function classifyArchiveInboxFailure(error: unknown): ArchiveInboxFailure {
  const chain = causeChain(error);
  for (const link of chain) {
    if (field(link, 'code') === 10003)
      return { kind: 'inaccessible', access: 'deleted', reason: 'discord-unknown-channel' };
    if (isForbiddenDiscordError(link))
      return { kind: 'inaccessible', access: 'denied', reason: `discord-${link.code}-forbidden` };
  }
  if (
    chain.some(
      (link) => link instanceof ArchiveCapacityError || link instanceof ArchiveBackpressureError,
    )
  )
    return { kind: 'capacity' };
  if (chain.some(isTransientFailure)) return { kind: 'transient' };
  return { kind: 'retry' };
}

/** Exponential backoff for the given counted attempt: one minute doubling to one hour. */
export function archiveInboxRetryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 16);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

/** Decides what a failed event becomes; the caller applies it under the event's claim. */
export function decideArchiveInboxFailure(
  failure: ArchiveInboxFailure,
  entry: { readonly attempts: number; readonly firstFailedAt?: number },
  now: number,
): ArchiveInboxDecision {
  switch (failure.kind) {
    case 'inaccessible':
      return { kind: 'gap', access: failure.access, reason: failure.reason };
    case 'capacity':
      return {
        kind: 'defer',
        retryAt: now + ARCHIVE_INBOX_CAPACITY_DELAY_MS,
        attempts: entry.attempts,
        ...(entry.firstFailedAt === undefined ? {} : { firstFailedAt: entry.firstFailedAt }),
      };
    case 'transient': {
      const firstFailedAt = entry.firstFailedAt ?? now;
      const failingFor = now - firstFailedAt;
      if (failingFor >= ARCHIVE_INBOX_TRANSIENT_WINDOW_MS)
        return { kind: 'dead', attempts: entry.attempts, firstFailedAt };
      // Waiting about as long as it has already failed doubles the interval each time.
      const delay = Math.min(RETRY_MAX_MS, Math.max(RETRY_BASE_MS, failingFor));
      return { kind: 'defer', retryAt: now + delay, attempts: entry.attempts, firstFailedAt };
    }
    case 'retry': {
      const attempts = entry.attempts + 1;
      const firstFailedAt = entry.firstFailedAt ?? now;
      if (attempts > ARCHIVE_INBOX_MAX_ATTEMPTS) return { kind: 'dead', attempts, firstFailedAt };
      return {
        kind: 'defer',
        retryAt: now + archiveInboxRetryDelay(attempts),
        attempts,
        firstFailedAt,
      };
    }
    default: {
      const unreachable: never = failure;
      throw new TypeError(`Unhandled archive inbox failure ${String(unreachable)}`);
    }
  }
}
