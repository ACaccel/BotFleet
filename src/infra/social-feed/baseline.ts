/**
 * Where a brand-new subscription's cursor should start.
 *
 * Two callers need this identical rule — the poller, when it meets a
 * subscription that has never been seeded, and the subscribe command,
 * which seeds one at creation time. Handlers and plugins are sibling
 * layers that may not import each other, so the shared rule lives in
 * infra, next to the platform it consults.
 */
import { MAX_FEED_SNAPSHOT_POSTS, type FeedPlatform, type FeedPost } from './types';

/** The slice of a platform the baseline rule actually consults. */
type BaselinePlatform = Pick<FeedPlatform, 'compareIds' | 'baselineIdAt' | 'trackingMode'>;

const MS_PER_SECOND = 1000;

/** A cursor anchoring "everything up to here has already been seen". */
export interface FeedBaselineCursor {
  readonly lastSeenId: string;
  readonly lastSeenTimestamp: number;
  readonly seenIds?: readonly string[];
}

/**
 * Highest-id entry on the page, used to seed a cursor so an account
 * joining the feed does not replay its timeline.
 *
 * Deliberately considers **every** entry, reposts and replies included,
 * rather than only the account's own posts. Ids are time-ordered within
 * a platform, so the highest id present is at or above everything
 * already published and any later post compares greater — which keeps
 * the baseline non-backfilling. Restricting it to own posts would return
 * `undefined` for a repost-only page, leaving no cursor, and the next
 * pass would then consume the account's first genuinely new post as its
 * baseline instead of forwarding it.
 *
 * Returns `undefined` for an empty page and for a page this platform
 * cannot totally order; {@link resolveBaselineCursor} then falls back to
 * the clock, which is the safe direction — a clock-derived floor still
 * suppresses the backfill, whereas a cursor the platform cannot compare
 * against would make every later pass forward nothing at all and leave
 * the subscription silently dead.
 *
 * A running maximum plus a verification pass rather than a sort.
 * `compareIds` is licensed to answer `0` for an id it cannot parse,
 * which makes it an inconsistent comparator: `Array.prototype.sort` has
 * unspecified output for one, and even a reduce would keep an
 * unparseable *first* entry, since nothing can beat it. Confirming that
 * the winner strictly beats every other distinct id closes both holes
 * and makes the result independent of page order.
 */
export const newestPostForBaseline = (
  platform: BaselinePlatform,
  posts: readonly FeedPost[],
): FeedPost | undefined => {
  const newest = posts.reduce<FeedPost | undefined>(
    (candidate, post) =>
      candidate === undefined || platform.compareIds(post.id, candidate.id) > 0 ? post : candidate,
    undefined,
  );
  if (newest === undefined) return undefined;
  const ordersAboveEveryOther = posts.every(
    (post) => post.id === newest.id || platform.compareIds(newest.id, post.id) > 0,
  );
  return ordersAboveEveryOther ? newest : undefined;
};

/**
 * The baseline cursor for a first read of `posts` taken at `nowMs`.
 *
 * Snapshots seed every ID, with timestamp plus ID deciding displayed progress
 * only. An empty snapshot seeds an empty ledger with a clock sentinel.
 *
 * An empty ordered timeline offers no post to anchor on, so the anchor is
 * derived from the clock instead — a platform-computed id floor rather
 * than zero, or a later full sweep would treat every pre-existing post
 * as new.
 */
export const resolveBaselineCursor = (
  platform: BaselinePlatform,
  posts: readonly FeedPost[],
  nowMs: number,
): FeedBaselineCursor => {
  if (platform.trackingMode === 'snapshot') {
    if (posts.length > MAX_FEED_SNAPSHOT_POSTS) {
      throw new Error('Feed snapshot exceeds its bounded source window');
    }
    const newest = posts.reduce<FeedPost | undefined>(
      (candidate, post) =>
        candidate === undefined ||
        post.createdTimestamp > candidate.createdTimestamp ||
        (post.createdTimestamp === candidate.createdTimestamp && post.id > candidate.id)
          ? post
          : candidate,
      undefined,
    );
    return {
      lastSeenId: newest?.id ?? `snapshot:${nowMs}`,
      lastSeenTimestamp: newest?.createdTimestamp ?? Math.floor(nowMs / MS_PER_SECOND),
      seenIds: [...new Set(posts.map((post) => post.id))],
    };
  }
  const newest = newestPostForBaseline(platform, posts);
  return {
    lastSeenId: newest?.id ?? platform.baselineIdAt(nowMs),
    lastSeenTimestamp: newest?.createdTimestamp ?? Math.floor(nowMs / MS_PER_SECOND),
  };
};
