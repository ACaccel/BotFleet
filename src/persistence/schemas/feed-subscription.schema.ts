/**
 * Social-feed subscription: one document per `(platform, account,
 * channel_id)` triple, carrying its filter and polling cursor. Each guild owns
 * its database, so the triple alone is the unique key.
 *
 * Each subscription keeps its own cursor, so an unsubscribe scoped to one
 * channel is well defined, a removed subscription leaves no orphaned cursor,
 * and re-subscribing starts from the present rather than replaying a backlog.
 *
 * `last_seen_id` is a String because X post ids are 64-bit and exceed
 * `Number.MAX_SAFE_INTEGER`; ordering is delegated to the platform adapter.
 *
 * {@link StoredFeedSubscription} is what a `lean` read hands back;
 * {@link FeedSubscriptionDoc} is the tightened contract the repository's
 * `normalize` produces from it, so the tightening is checked, not asserted.
 */
import { Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * Media constraint a subscription may place on a post. `media_only`
 * reproduces the historical behaviour of forwarding only posts that
 * carry an attachment; `any` also forwards text-only posts.
 *
 * Declared here rather than in `infra/` because a schema must not
 * depend on a higher layer — the plugin and the handlers import the
 * literals from persistence, not the other way round.
 *
 * The `as const` is load-bearing twice over: it is what makes
 * {@link FeedMediaFilter} a union rather than `string`, and what lets
 * mongoose infer the same union onto the stored field.
 */
export const FEED_MEDIA_FILTERS = ['media_only', 'photo_only', 'video_only', 'any'] as const;

export type FeedMediaFilter = (typeof FEED_MEDIA_FILTERS)[number];

/** Filter applied when a subscription does not state one. */
export const DEFAULT_FEED_MEDIA_FILTER = 'media_only' as const satisfies FeedMediaFilter;

/**
 * Narrow a stored value to a known media filter.
 *
 * Mongoose enforces the `enum` on write only, and a `lean` read is an
 * unchecked assertion, so a value hand-edited into the collection — or
 * written by a future build that knows more filters than this one —
 * would otherwise reach the domain wearing a type it does not have.
 */
export const isFeedMediaFilter = (value: unknown): value is FeedMediaFilter =>
  typeof value === 'string' && (FEED_MEDIA_FILTERS as readonly string[]).includes(value);

/**
 * Per-subscription filter. Missing fields mean "the default", so
 * adding a filter option later needs no data migration. Repository
 * reads are `lean`, which bypasses these defaults, so the repo applies
 * them on the way out — this declaration is the schema-side half of
 * that contract.
 */
const feedSubscriptionFilterSchema = new Schema(
  {
    media: { type: String, enum: FEED_MEDIA_FILTERS, default: DEFAULT_FEED_MEDIA_FILTER },
    /** Case-insensitive substring the post text must contain. */
    keyword: { type: String, required: false, maxlength: 100 },
  },
  { _id: false },
);

export const feedSubscriptionSchema = new Schema({
  platform: { type: String, required: true },
  /** Account handle, already normalised by the platform adapter. */
  account: { type: String, required: true },
  channel_id: { type: String, required: true },
  created_by: { type: String, required: true },
  /** Creation time, unix **milliseconds** (`Date.now()`). */
  created_at: { type: Number, required: true },
  filter: { type: feedSubscriptionFilterSchema, required: true, default: () => ({}) },
  /** Newest post already forwarded; absent until the cursor is seeded. */
  last_seen_id: { type: String, required: false },
  /** Timestamp of `last_seen_id`, unix **seconds** — the upstream unit. */
  last_seen_timestamp: { type: Number, required: false },
});

// The subscription key. The individual fields are
// deliberately not unique on their own: one account may feed several
// channels, and one channel may carry several accounts.
feedSubscriptionSchema.index({ platform: 1, account: 1, channel_id: 1 }, { unique: true });

type InferredFeedSubscription = InferSchemaType<typeof feedSubscriptionSchema>;

/**
 * Subscription filter as the repository hands it out: `media` is
 * always a known value, and an absent `keyword` is `undefined` rather
 * than `undefined | null`.
 */
export interface FeedSubscriptionFilter {
  media: FeedMediaFilter;
  keyword?: string;
}

/**
 * A subscription as the repository hands it out.
 *
 * Tighter than what mongoose infers, in two ways the repository
 * guarantees on every read: the filter always carries its defaults,
 * and `undefined` is the single representation of an unset field. The
 * inferred type admits `null` as well, which would force every caller
 * to write two checks for one state.
 */
export type FeedSubscriptionDoc = Omit<
  InferredFeedSubscription,
  'filter' | 'last_seen_id' | 'last_seen_timestamp'
> & {
  readonly _id: Types.ObjectId;
  filter: FeedSubscriptionFilter;
  last_seen_id?: string;
  last_seen_timestamp?: number;
};

/**
 * A subscription as a `lean` read really returns it.
 *
 * `lean` yields the raw driver object: mongoose applies neither
 * defaults nor `enum` validation on the way out, and any optional path
 * may hold an explicit `null`. So the filter may be absent, partial,
 * or carry a `media` string this build does not know. Saying so here
 * is what makes the repository's `normalize` a checked conversion
 * instead of a type-level no-op.
 */
export type StoredFeedSubscription = Omit<
  InferredFeedSubscription,
  'filter' | 'last_seen_id' | 'last_seen_timestamp'
> & {
  readonly _id: Types.ObjectId;
  filter?: { media?: string | null; keyword?: string | null } | null;
  last_seen_id?: string | null;
  last_seen_timestamp?: number | null;
};
