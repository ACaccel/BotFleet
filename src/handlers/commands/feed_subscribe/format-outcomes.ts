/**
 * Renders what `/feed subscribe` did with each account it was given.
 *
 * One invocation can name up to `MAX_FEED_ACCOUNTS` accounts and a
 * failure line carries a whole sentence, so the report can outgrow a
 * single Discord message — hence pages rather than a string. Every
 * account appears, including the ones that failed or were never
 * attempted: the member has to be able to tell which handles are now
 * subscribed and which need retyping.
 *
 * This is also where a failure becomes words. The batch loop keeps the
 * error itself, so the operator log can have the untranslated code and
 * the member a sentence in their own language; both renderings live
 * here, side by side, rather than one of them being frozen at the point
 * the error was caught.
 */
import { DomainError, type AnyDomainError } from '../../../core/errors';
import type { BoundTranslate } from '../../../core/i18n';
import { paginateLines } from '../../../infra/discord/paginate';
import { formatFeedFilter, type DescribableFeedFilter } from '../../feed-filter-labels';
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
  /** Channel mention, rendered by the handler that resolved the channel. */
  readonly channel: string;
  /** The filter this invocation wrote, worded here rather than by the handler. */
  readonly filter: DescribableFeedFilter;
}

/**
 * The member-facing sentence for a failure.
 *
 * A `DomainError` names its own catalog key, which is how an invalid
 * handle and an upstream 404 read differently. A key with no catalog
 * entry — i18next echoes it back — and anything that is not a
 * `DomainError` degrade to the generic copy rather than showing a
 * member a raw key or an internal message.
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
 * Make an account string safe to quote back, the same defence
 * `XPlatform` applies to the handles it refuses.
 *
 * A canonical handle needs none of this, but a failed or skipped
 * outcome carries whatever the member typed, and the translator
 * interpolates without escaping — so an unbounded string could put
 * backticks, or simply length, into the bot's own message. The parser
 * has already removed whitespace, leaving the ceiling and the backticks
 * to deal with here.
 */
const echoableAccount = (raw: string): string =>
  raw.replace(/`/g, ' ').slice(0, MAX_ECHOED_ACCOUNT_LENGTH);

/**
 * One account's line, keyed by its outcome. A `switch` with an
 * exhaustiveness guard rather than a ternary chain: a fourth outcome
 * has to fail the build here instead of silently rendering as one of
 * the three that already exist.
 *
 * Both success lines carry `label`, the filter now in force: a
 * re-subscribe replaces the stored filter wholesale, so a member can
 * lose a keyword and only this line would say so.
 */
const formatOutcome = (outcome: FeedSubscribeOutcome, label: string, t: BoundTranslate): string => {
  switch (outcome.status) {
    case 'created':
      return t('replies:feed.account_subscribed', { account: outcome.account, filter: label });
    case 'updated':
      return t('replies:feed.account_updated', { account: outcome.account, filter: label });
    case 'skipped':
      return t('replies:feed.account_skipped', { account: echoableAccount(outcome.account) });
    case 'failed':
      return t('replies:feed.account_failed', {
        account: echoableAccount(outcome.account),
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
export const formatOutcomesForLog = (outcomes: readonly FeedSubscribeOutcome[]): string =>
  outcomes
    .map((outcome) =>
      outcome.status === 'failed'
        ? `@${echoableAccount(outcome.account)} failed(${codeOf(outcome.cause)})`
        : `@${echoableAccount(outcome.account)} ${outcome.status}`,
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
    ...outcomes.map((outcome) => formatOutcome(outcome, label, t)),
  ];
  return paginateLines(lines);
};
