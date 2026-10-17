/**
 * Renders what `/feed subscribe` did with each account it was given.
 *
 * Every target appears, including failed and unattempted ones, so the
 * member knows what needs retrying. Failure sentences can make a full
 * batch exceed Discord's limit, so the report returns pages.
 *
 * Keep errors intact until rendering: members receive translated copy,
 * while operator logs retain searchable error codes.
 */
import { DomainError, type AnyDomainError } from '../../../core/errors';
import type { BoundTranslate } from '../../../core/i18n';
import { paginateLines } from '../../../infra/discord/paginate';
import { formatFeedFilter, type DescribableFeedFilter } from '../../feed-filter-labels';
import { formatFeedTarget } from '../../feed-target-label';
import type { FeedSubscribeOutcome } from './subscribe-accounts';

/** Copy used when a failure carries no renderable catalog key. */
const UNKNOWN_REASON_KEY = 'replies:feed.reason_unknown';

/** Ceiling on how much of a rejected account string is quoted back. */
const MAX_ECHOED_ACCOUNT_LENGTH = 32;

/** Operator-log code for the same case; never shown to a member. */
const UNKNOWN_FAILURE_CODE = 'UNEXPECTED';

/** What the report says about the destination the batch was written to. */
interface SubscribeReportContext {
  /** Platform display name, as every other feed message spells it. */
  readonly platform: string;
  /** Adapter ID controls target labels independently of its display name. */
  readonly platformId?: string;
  /** Channel mention, rendered by the handler that resolved the channel. */
  readonly channel: string;
  /** The filter this invocation wrote, worded here rather than by the handler. */
  readonly filter: DescribableFeedFilter;
}

/**
 * The member-facing sentence for a failure.
 *
 * Missing catalog entries and non-domain errors use generic copy to
 * avoid exposing raw keys or internal messages.
 */
const reasonOf = (cause: unknown, t: BoundTranslate): string => {
  if (!(cause instanceof DomainError)) return t(UNKNOWN_REASON_KEY);
  const error: AnyDomainError = cause;
  const resolved = t(error.messageKey, error.messageParams);
  const usable = resolved !== error.messageKey && resolved.length > 0;
  return usable ? resolved : t(UNKNOWN_REASON_KEY);
};

/** The operator-log spelling of the same failure. */
const codeOf = (cause: unknown): string => {
  if (!(cause instanceof DomainError)) return UNKNOWN_FAILURE_CODE;
  const error: AnyDomainError = cause;
  return error.code;
};

/**
 * Failed and skipped outcomes contain untrusted input. Bound the echo
 * and remove backticks because translation interpolates without escaping.
 */
const echoableAccount = (raw: string): string =>
  raw.replace(/`/g, ' ').slice(0, MAX_ECHOED_ACCOUNT_LENGTH);

/**
 * One account's line, keyed by its outcome. A `switch` with an
 * exhaustiveness guard rather than a ternary chain: a fourth outcome
 * has to fail the build here instead of silently rendering as one of
 * the three that already exist.
 *
 * Success lines name the current filter because re-subscribing replaces
 * it wholesale and may clear a previously configured keyword.
 */
const formatOutcome = (
  outcome: FeedSubscribeOutcome,
  label: string,
  platformId: string,
  t: BoundTranslate,
): string => {
  const account = formatFeedTarget(
    platformId,
    outcome.status === 'failed' || outcome.status === 'skipped'
      ? echoableAccount(outcome.account)
      : outcome.account,
    t,
  );
  switch (outcome.status) {
    case 'created':
      return t('replies:feed.account_subscribed', { account, filter: label });
    case 'updated':
      return t('replies:feed.account_updated', { account, filter: label });
    case 'skipped':
      return t('replies:feed.account_skipped', { account });
    case 'failed':
      return t('replies:feed.account_failed', {
        account,
        reason: reasonOf(outcome.cause, t),
      });
    default: {
      const unreachable: never = outcome;
      throw new TypeError(`unhandled feed subscribe outcome: ${JSON.stringify(unreachable)}`);
    }
  }
};

/**
 * Plain, untranslated rendering of the whole batch for the operator
 * log, the counterpart of `/feed unsubscribe`'s removal line.
 *
 * A failed account contributes its `DomainError` code rather than the
 * member-facing sentence: the log is read in one language, and the code
 * is what an operator can search for.
 */
export const formatOutcomesForLog = (
  outcomes: readonly FeedSubscribeOutcome[],
  platformId = '',
): string =>
  outcomes
    .map((outcome) =>
      outcome.status === 'failed'
        ? `${formatFeedTarget(platformId, echoableAccount(outcome.account))} failed(${codeOf(outcome.cause)})`
        : `${formatFeedTarget(platformId, echoableAccount(outcome.account))} ${outcome.status}`,
    )
    .join('; ');

/**
 * The pages reporting `outcomes`, under a header naming the platform
 * and the destination channel.
 *
 * Returns an empty array for an empty batch. That cannot happen through
 * the command — it refuses an empty account list before writing
 * anything — so the caller is spared a "nothing happened" message it
 * has no way to reach.
 */
export const formatOutcomePages = (
  outcomes: readonly FeedSubscribeOutcome[],
  context: SubscribeReportContext,
  t: BoundTranslate,
): readonly string[] => {
  if (outcomes.length === 0) return [];
  // Rendered once: the filter is per-invocation, not per-account.
  const label = formatFeedFilter(context.filter, t);
  const lines: string[] = [
    t('replies:feed.subscribe_header', { platform: context.platform, channel: context.channel }),
    ...outcomes.map((outcome) => formatOutcome(outcome, label, context.platformId ?? '', t)),
  ];
  return paginateLines(lines);
};
