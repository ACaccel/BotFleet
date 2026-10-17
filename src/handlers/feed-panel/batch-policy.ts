/**
 * When `/feed subscribe` stops working through its account list.
 *
 * Both rules exist because per-account failure isolation, left
 * unbounded, turns one member's typo-ridden command into twenty
 * requests at an upstream that is already refusing, or into a batch
 * that outlives the interaction it has to answer. They live apart from
 * the loop because they are the part worth stating — and testing —
 * without a repository or a platform in hand.
 */
import { DomainError, type AnyDomainError } from '../../core/errors';

/**
 * How long the batch may keep starting accounts, measured from the
 * interaction's creation.
 *
 * Discord expires a deferred interaction 15 minutes after it is
 * created, and the report is only worth producing if it can still be
 * sent. The worst case per new account is the platform timeout times
 * its retry attempts plus backoff — roughly 28 seconds at the shipped
 * 8-second timeout, but roughly 95 at the configurable 30-second
 * ceiling, so a full list of new accounts can overrun the window on a
 * bad day. Stopping at 13 minutes keeps two in hand for delivery.
 */
export const FEED_BATCH_BUDGET_MS = 13 * 60 * 1000;

/**
 * Whether the next account would fail the same way.
 *
 * A rate limit and a database outage are properties of the batch, not
 * of the account that happened to meet them. `FxTwitterTimelineSource`
 * deliberately does not retry a 429 because the poller's interval is
 * the correct backoff; walking the rest of the list here would undo
 * that restraint one request at a time. Every other failure — an
 * unusable handle, an account that does not exist — says nothing about
 * the next account and must not stop anything.
 */
export const isSystemicFailure = (cause: unknown): boolean => {
  if (!(cause instanceof DomainError)) return false;
  const error: AnyDomainError = cause;
  return error.code === 'FEED_RATE_LIMITED' || error.code.startsWith('DATABASE_');
};
