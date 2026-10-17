/**
 * The domain sequence a subscription command runs before it writes:
 * canonicalise the handle, and, only when the subscription is new, read the
 * upstream once to prove the account exists and to anchor a cursor. Snapshot
 * baselines also capture every current native ID, including an empty ledger.
 *
 * It is the platform-facing half of subscribing, so it sits next to
 * {@link FeedPlatform} and the baseline rule it composes, leaving the
 * handler with only Discord work.
 *
 * The upstream read is skipped for an existing subscription on purpose.
 * Re-running the command is how a filter is changed, the stored cursor is
 * preserved either way, and an upstream outage must not stand between a
 * member and turning a keyword off.
 */
import { ok, type Result } from '../../core/result';
import { resolveBaselineCursor, type FeedBaselineCursor } from './baseline';
import type { FeedFailure, FeedPlatform } from './types';

interface PreparedFeedSubscription {
  /** The handle as the platform spells it, and as it is stored. */
  readonly account: string;
  /**
   * Cursor to seed. `undefined` when the subscription already exists,
   * which is the signal that no upstream read happened and that the
   * stored cursor must be left alone.
   */
  readonly cursor: FeedBaselineCursor | undefined;
}

interface PrepareFeedSubscriptionDeps {
  /**
   * Wall clock in unix milliseconds, read by the caller **before** this
   * call. It only anchors the cursor when the timeline comes back
   * empty, and a timestamp taken before the request is the safe
   * direction: a later one could sit past a post published while the
   * request was in flight and skip it forever.
   */
  readonly nowMs: number;
  /**
   * Whether this account is not yet subscribed in the target channel,
   * and therefore needs a cursor.
   *
   * A callback rather than a boolean because the answer depends on the
   * canonical account, which only exists once the platform has
   * normalised the raw input. A rejection propagates unchanged — the
   * caller's own error boundary owns database failures, and folding one
   * onto this function's `FeedFailure` rail would mislabel it as a
   * platform problem.
   */
  isNew(account: string): Promise<boolean>;
}

/**
 * Validate `rawAccount` and, for a new subscription, seed its cursor.
 *
 * Every failure arrives on the Err rail as a {@link FeedFailure}: an
 * unusable handle as `FEED_INVALID_ACCOUNT`, an unreachable or unknown
 * account as whatever the platform's translator produced.
 */
export const prepareFeedSubscription = async (
  platform: FeedPlatform,
  rawAccount: string,
  deps: PrepareFeedSubscriptionDeps,
): Promise<Result<PreparedFeedSubscription, FeedFailure>> => {
  const normalized = await platform.normalizeAccount(rawAccount);
  if (!normalized.ok) return normalized;
  const account = normalized.value;

  if (!(await deps.isNew(account))) return ok({ account, cursor: undefined });

  const page = await platform.fetchTimeline(account);
  if (!page.ok) return page;
  return ok({ account, cursor: resolveBaselineCursor(platform, page.value, deps.nowMs) });
};
