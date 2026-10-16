/**
 * Pure selection logic over a fetched timeline page: which entries a
 * subscription actually wants, which of those are new, and in what
 * order they go out.
 *
 * Two tiers of rule, deliberately separated:
 *
 *   - **Hard rules**, which no subscription may relax — the post must
 *     be the followed account's own (not a repost of someone else's)
 *     and must not be a reply. Forwarding either would put text a third
 *     party wrote, or a fragment of a conversation, into a channel that
 *     asked for one account's posts.
 *   - **Subscription filter**, the operator-chosen media and keyword
 *     narrowing, whose defaults forward only media-carrying posts.
 *
 * Reads {@link FeedPost} fields only; ordering and cursor comparison are
 * delegated to the platform, so no platform-specific arithmetic (X's
 * snowflake ids) leaks into the plugin. Free of I/O.
 */
import type { FeedPlatform, FeedPost } from '../../../infra/social-feed';
import type { FeedMediaFilter } from '../../../persistence/schemas/feed-subscription.schema';

/**
 * The narrowing one subscription applies on top of the hard rules.
 *
 * Structurally identical to the stored `filter` sub-document, and
 * declared here so the selection rules state their own input contract —
 * read-only, and narrowed to the two fields they consult — rather than
 * inheriting the stored document's mutability.
 */
export interface SubscriptionFilter {
  readonly media: FeedMediaFilter;
  /** Case-insensitive substring the post text must contain. */
  readonly keyword?: string;
}

/** Inputs to {@link selectPostsToForward}. */
interface SelectPostsInput {
  /** Platform the subscription follows; owns id ordering. */
  readonly platform: FeedPlatform;
  /** Followed account, already normalised by the platform. */
  readonly account: string;
  readonly filter: SubscriptionFilter;
  /** Newest post id already forwarded; absent before the cursor is seeded. */
  readonly lastSeenId?: string;
  /** Upper bound on how many posts one pass may forward. */
  readonly maxPosts: number;
}

/**
 * True when the entry is a post this account itself published — not a
 * repost of someone else's.
 *
 * `isRepost` is the upstream's own marker; the author comparison is a
 * second, independent check, because a repost entry carries the
 * *original* author. Account names are compared case-insensitively:
 * the stored account is normalised, but nothing constrains how a
 * platform spells the author on the post itself.
 */
const isOwnPost = (post: FeedPost, account: string): boolean =>
  !post.isRepost && post.authorAccount.toLowerCase() === account.toLowerCase();

/** True when the post carries the media this subscription asked for. */
const matchesMedia = (post: FeedPost, media: FeedMediaFilter): boolean => {
  switch (media) {
    case 'media_only':
      return post.media.length > 0;
    case 'photo_only':
      return post.media.some((item) => item.kind === 'photo');
    case 'video_only':
      return post.media.some((item) => item.kind === 'video');
    case 'any':
      return true;
    default: {
      // Exhaustiveness guard: a new FeedMediaFilter without a case above
      // becomes a compile error rather than silently forwarding.
      const exhaustive: never = media;
      return exhaustive;
    }
  }
};

/**
 * True when the post body contains the keyword, case-insensitively.
 *
 * A post whose platform reported no text carries `''`, which matches no
 * keyword — so a keyword subscription on a platform that does not
 * expose post text forwards nothing rather than everything. That is the
 * safe direction for a filter whose purpose is to narrow.
 */
const matchesKeyword = (post: FeedPost, keyword: string | undefined): boolean =>
  keyword === undefined || post.text.toLowerCase().includes(keyword.toLowerCase());

/**
 * Choose the posts a pass should forward for one subscription: the
 * account's own, original (non-reply) posts that match the
 * subscription's filter and are newer than its cursor, oldest first.
 *
 * The cap takes the **oldest** eligible posts rather than the newest.
 * Because the caller advances the cursor only to the last post it
 * actually delivered, the remainder is picked up by the following pass;
 * taking the newest instead would step the cursor over the middle of the
 * backlog and drop it permanently.
 */
export const selectPostsToForward = (
  posts: readonly FeedPost[],
  input: SelectPostsInput,
): readonly FeedPost[] => {
  const { platform, filter, lastSeenId } = input;
  const eligible = posts.filter((post) => {
    if (!isOwnPost(post, input.account)) return false;
    // Replies (including this account's own thread continuations) are
    // not original posts, so they stay out of the feed.
    if (post.isReply) return false;
    if (!matchesMedia(post, filter.media)) return false;
    if (!matchesKeyword(post, filter.keyword)) return false;
    if (lastSeenId === undefined) return true;
    return platform.compareIds(post.id, lastSeenId) > 0;
  });
  // `filter` already returned a fresh array, so sorting it in place
  // cannot disturb the caller's page.
  return eligible.sort((a, b) => platform.compareIds(a.id, b.id)).slice(0, input.maxPosts);
};
