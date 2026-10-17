/**
 * Platform-neutral social-feed types and the {@link FeedPlatform} Strategy.
 * Everything returned is neutral data with no discord.js types, so a
 * platform stays unit-testable without a client.
 *
 * Platforms differ not only in fetching but in account spelling, post-id
 * ordering and the URL Discord can unfurl. Pinning the plugin and the
 * subscription commands to {@link FeedPlatform} keeps a new source to one
 * file in `./platforms/` plus one composition-root line, and keeps
 * platform-specific arithmetic (X's snowflake ids) out of the plugin.
 *
 * Error contract: `fetchTimeline` and `normalizeAccount` return every
 * failure on the Err rail and never throw: a feed read is background work
 * whose failure is logged and retried on the next pass.
 */
import type { FeedError } from '../../core/errors';
import type { Result } from '../../core/result';
import type { Logger } from '../../core/logger';
import type { LinkPreviewFailure, RenderablePreviewResult } from '../link-preview';

/** Snapshot sources must return their complete bounded window, never a cursor slice. */
export const MAX_FEED_SNAPSHOT_POSTS = 1000;

/** Feed previews must fit in one send so delivery-based cursors remain atomic. */
export type FeedPreview = Exclude<RenderablePreviewResult, { readonly kind: 'card' }>;

/**
 * Platform ids the bot ships support for.
 *
 * Two consumers only: the `platform` option's choices on the
 * subscription commands, and the key set of the `social_feed.platforms`
 * config block. It is deliberately *not* the type of
 * {@link FeedPlatform.id} — see that field.
 */
export const SUPPORTED_FEED_PLATFORMS = ['x', 'bahamut', 'youtube'] as const;

export type FeedPlatformId = (typeof SUPPORTED_FEED_PLATFORMS)[number];

/**
 * The one user-facing spelling of each shipped platform.
 *
 * The registry holds only the platforms an operator configured, so a
 * command naming an unconfigured one has no adapter to ask for a
 * display name. This map is what lets that refusal still name the
 * platform the way every other message does, instead of echoing the
 * raw registry id. {@link FeedPlatform.displayName} on a shipped
 * platform reads from here, which is what keeps the two spellings from
 * drifting apart.
 *
 * A `Record` keyed by {@link FeedPlatformId}, so adding an id to
 * `SUPPORTED_FEED_PLATFORMS` without a name here is a compile error.
 */
export const FEED_PLATFORM_DISPLAY_NAMES: Readonly<Record<FeedPlatformId, string>> = {
  x: 'X (Twitter)',
  bahamut: 'Bahamut',
  youtube: 'YouTube',
};

/**
 * Widened {@link FeedError} used on the Err rail of every platform. The
 * params shape mirrors the LLM / link-preview convention so the
 * `errors:feed.*` catalog templates render uniformly.
 *
 * Only `platform` is always available. `account` and `status` are
 * optional because two codes in the taxonomy never reach an upstream:
 * `FEED_PLATFORM_NOT_CONFIGURED` has no account, and neither it nor
 * `FEED_INVALID_ACCOUNT` has an HTTP status. Their catalog entries
 * interpolate no `{{status}}`, so requiring one would only force every
 * call site to invent a value that renders nowhere.
 */
export type FeedFailure = FeedError<{
  /** Platform display name, falling back to the registry id when none resolved. */
  platform: string;
  /** Absent when the failure is not about one specific account. */
  account?: string;
  /** HTTP status or transport label; absent for failures that sent no request. */
  status?: string;
}>;

/** A single image or video attached to a post. */
export interface FeedPostMedia {
  readonly kind: 'photo' | 'video';
  /** Direct media URL, kept for logging and any future re-upload path. */
  readonly url: string;
}

/**
 * One post from an account's timeline, normalised to the fields the
 * feed needs.
 *
 * `id` stays a **string**. Ids are opaque to every consumer: X's are
 * 64-bit and already exceed `Number.MAX_SAFE_INTEGER` (a live sample
 * reads `2092744659667673582`), while another platform's may not be
 * numeric at all. Ordered sources therefore use
 * {@link FeedPlatform.compareIds}, never `Number`; snapshot sources use ID membership.
 */
export interface FeedPost {
  /** Stable native ID; snapshot sources never order it. */
  readonly id: string;
  /**
   * Author's account name without any leading `@`. On a repost this is
   * the **original** author, not the account whose timeline was read.
   */
  readonly authorAccount: string;
  /** Optional display name; authorAccount remains the canonical ownership key. */
  readonly authorName?: string;
  /** Creation time in unix seconds; deleted checkpoints retain the preceding source time. */
  readonly createdTimestamp: number;
  /** A verified deletion can advance a source cursor but is never delivered. */
  readonly isDeleted?: boolean;
  /** Canonical permalink, e.g. `https://x.com/<account>/status/<id>`. */
  readonly url: string;
  /**
   * Post body, or `''` when the platform reports none. Never
   * `undefined`: keyword filtering reads this on every post, and an
   * optional field would push a null check into each call site for no
   * behavioural gain — "no text" and "empty text" match nothing alike.
   */
  readonly text: string;
  /** True when the post replies to another post (including self-threads). */
  readonly isReply: boolean;
  /** True when the entry is a repost of someone else's post. */
  readonly isRepost: boolean;
  /** Attached media; empty for a text-only post. */
  readonly media: readonly FeedPostMedia[];
}

/** Per-call tuning for {@link FeedPlatform.fetchTimeline}. */
export interface FeedTimelineFetchOptions {
  /** Oldest delivered cursor in the group; retained even during full sweeps. */
  readonly afterId?: string;
  /** Maximum records in a cursor-aware source batch. */
  readonly limit?: number;
  /**
   * Only ask for posts newer than this unix-seconds timestamp. This is a
   * bandwidth hint, not a filter: an implementation may still return
   * older posts, so the caller must de-duplicate on {@link FeedPost.id}.
   */
  readonly sinceTimestamp?: number;
}

/**
 * One social platform the feed can follow (Strategy). Ordered sources use
 * `compareIds`; snapshots use timestamp ordering and persistent ID membership.
 */
export interface FeedPlatform {
  /**
   * Registry key, e.g. `'x'`.
   *
   * Typed `string` rather than {@link FeedPlatformId} on purpose: the
   * registry must accept a platform the shipped union does not name, so
   * a test fake can drive the plugin and the commands end to end
   * without touching a real upstream. `SUPPORTED_FEED_PLATFORMS`
   * constrains what an operator or a command user may *select*, which
   * is a separate question from what the registry can *hold*.
   */
  readonly id: string;
  /** Human-readable platform name used in messages and log lines. */
  readonly displayName: string;
  /** Source feeds follow forum events by any author; absent means own original posts. */
  readonly subscriptionScope?: 'account' | 'source';
  /** Absent uses ordered IDs; snapshots deduplicate opaque native IDs persistently. */
  readonly trackingMode?: 'snapshot';
  /**
   * Cursor sources return the current head without afterId, and the oldest
   * next batch with afterId. The poller can pass intentionally filtered records.
   */
  readonly supportsCursorPagination?: boolean;
  /** Default narrowing when the command omits its media option. */
  readonly defaultMediaFilter?: 'media_only' | 'any';
  /**
   * Canonicalise a handle or source URL into one stored target key.
   * URL aliases may need an asynchronous public metadata lookup.
   */
  normalizeAccount(raw: string): Result<string, FeedFailure> | Promise<Result<string, FeedFailure>>;
  /**
   * Read `account`'s recent posts. `Ok([])` means "nothing new", which
   * is the common case for a poller and must not be treated as an error.
   */
  fetchTimeline(
    account: string,
    options?: FeedTimelineFetchOptions,
  ): Promise<Result<readonly FeedPost[], FeedFailure>>;
  /**
   * Ascending comparison for ordered sources; snapshot consumers ignore it.
   *
   * Returns `0` when either id is unparseable, so an upstream id-format
   * change degrades to "leave the order alone" instead of throwing
   * inside a background loop.
   */
  compareIds(a: string, b: string): number;
  /**
   * The lowest id a post created at `nowMs` could carry, used to anchor
   * an ordered cursor when a first read returns an empty timeline. Ignored
   * for snapshots. For ordered sources it must sort
   * above everything already published and below everything published
   * afterwards — that is what makes a fresh subscription non-backfilling.
   */
  baselineIdAt(nowMs: number): string;
  /**
   * The URL to actually post to Discord. Platforms whose canonical links
   * do not unfurl substitute an embed-proxy host here, so the plugin
   * never has to know which platform needs one.
   */
  toEmbedUrl(post: FeedPost): string;
  /** Optional neutral preview; absence preserves URL-only delivery for other platforms. */
  buildPreview?(
    post: FeedPost,
    logger?: Logger,
  ): Promise<Result<FeedPreview | null, LinkPreviewFailure>>;
}
