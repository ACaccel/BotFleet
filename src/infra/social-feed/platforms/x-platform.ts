/**
 * `XPlatform` — the X (Twitter) implementation of {@link FeedPlatform}.
 *
 * Everything X-specific that the feed needs lives here: how an account
 * name is spelled, how two snowflake ids order, what a "now" cursor
 * looks like, and which host Discord can unfurl. Reading the timeline
 * itself is delegated to an {@link XTimelineSource}, which keeps the
 * HTTP client swappable and lets this class be unit-tested without a
 * network.
 */
import { err, ok, type Result } from '../../../core/result';
import { FeedError } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import {
  createTwitterProvider,
  OgClient,
  invalidResponseError,
  type LinkPreviewProvider,
  type LinkPreviewFailure,
} from '../../link-preview';
import { translateFeedError } from './error-translator';
import { FxTwitterTimelineSource } from './fxtwitter-source';
import {
  DEFAULT_X_API_BASE_URL,
  X_PLATFORM_DISPLAY_NAME,
  X_PLATFORM_ID,
  type XTimelineSource,
} from './x-types';
import type {
  FeedFailure,
  FeedPlatform,
  FeedPost,
  FeedPreview,
  FeedTimelineFetchOptions,
} from '../types';

/**
 * X account names are ASCII letters, digits, and underscores, capped at
 * 15 characters by X itself. Validating here means a typo is rejected at
 * subscription time instead of producing a 404 on every pass forever.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** Ceiling on how much of a rejected account string is quoted back. */
const MAX_ECHOED_ACCOUNT_LENGTH = 32;

/**
 * Make a rejected account string safe to quote back to the user.
 *
 * The value reaches a Discord reply through `messageParams`, and the
 * translator interpolates without escaping, so an unbounded raw string
 * would let a caller inject backticks and newlines into the bot's own
 * message — or simply push the reply past Discord's length limit. The
 * user still needs to see roughly what was rejected, so it is truncated
 * and defused rather than dropped.
 *
 * A leading `@` is dropped because the catalog template already writes
 * one; echoing `@@handle` back at someone who typed the `@` themselves
 * reads like a second defect on top of the rejection.
 */
const echoableAccount = (raw: string): string =>
  raw
    .trim()
    .replace(/^@+/, '')
    .replace(/[`\r\n]/g, ' ')
    .slice(0, MAX_ECHOED_ACCOUNT_LENGTH);

/**
 * Start of X's snowflake epoch, in Unix milliseconds.
 *
 * A fixed protocol value: post ids embed `(createdMs - EPOCH) << 22`, so
 * this constant is what makes an id and a wall-clock time comparable.
 * Verified against live posts — decoding each sample's id reproduces its
 * reported `created_timestamp` to the second.
 */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657;

/** Bits an X snowflake reserves below the timestamp (worker + sequence). */
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

/**
 * Parse an X post id for comparison.
 *
 * Ids are 64-bit and already exceed `Number.MAX_SAFE_INTEGER`, so
 * `BigInt` is the only safe comparison. A non-numeric id means the
 * upstream id format changed; `null` makes the caller leave the order
 * alone rather than throw inside a background loop.
 */
const toBigIntOrNull = (id: string): bigint | null => {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
};

/** Construction-time settings for {@link XPlatform}. */
interface XPlatformOptions {
  /** API origin, without a trailing slash. Defaults to the public host. */
  readonly apiBaseUrl?: string;
  /** Per-request hard timeout, in milliseconds. */
  readonly timeoutMs: number;
  /** Host substituted into a post permalink so Discord unfurls a playable embed. */
  readonly embedProxyHost: string;
  /** Injection seam for tests; production builds an {@link FxTwitterTimelineSource}. */
  readonly source?: XTimelineSource;
  /** Shared preview HTTP boundary; injectable for deterministic hybrid tests. */
  readonly ogClient?: OgClient;
}

export class XPlatform implements FeedPlatform {
  public readonly id = X_PLATFORM_ID;
  public readonly displayName = X_PLATFORM_DISPLAY_NAME;
  public readonly defaultMediaFilter = 'any';

  private readonly source: XTimelineSource;
  private readonly embedProxyHost: string;
  private readonly previewProvider: LinkPreviewProvider;
  private readonly timeoutMs: number;

  public constructor(options: XPlatformOptions) {
    this.source =
      options.source ??
      new FxTwitterTimelineSource({
        apiBaseUrl: options.apiBaseUrl,
        timeoutMs: options.timeoutMs,
      });
    this.embedProxyHost = options.embedProxyHost;
    this.timeoutMs = options.timeoutMs;
    this.previewProvider = createTwitterProvider({
      apiBaseUrls: [options.apiBaseUrl ?? DEFAULT_X_API_BASE_URL],
      proxyHosts: [options.embedProxyHost],
      ogClient: options.ogClient ?? new OgClient(),
    });
  }

  /** Use the same hybrid decision as shared-link previews without Discord I/O. */
  public async buildPreview(
    post: FeedPost,
    logger?: Logger,
  ): Promise<Result<FeedPreview | null, LinkPreviewFailure>> {
    let url: URL;
    try {
      url = new URL(post.url);
    } catch {
      return err(invalidResponseError('twitter'));
    }
    if (!this.previewProvider.canHandle(url)) return err(invalidResponseError('twitter'));
    const result = await this.previewProvider.build(url, { timeoutMs: this.timeoutMs, logger });
    if (!result.ok) return result;
    if (result.value?.kind === 'card' || result.value?.kind === 'gallery') {
      return err(invalidResponseError('twitter'));
    }
    return ok(result.value);
  }

  /**
   * Strip a leading `@`, trim, and lower-case. X account names are
   * case-insensitive, so folding case here is what makes one account
   * resolve to one subscription key however a user typed it.
   */
  public normalizeAccount(raw: string): Result<string, FeedFailure> {
    const account = raw.trim().replace(/^@+/, '').toLowerCase();
    if (!ACCOUNT_PATTERN.test(account)) {
      const echoed = echoableAccount(raw);
      return err(
        new FeedError({
          code: 'FEED_INVALID_ACCOUNT',
          messageKey: 'errors:feed.invalid_account',
          messageParams: { platform: this.displayName, account: echoed },
          context: {
            operation: 'XPlatform.normalizeAccount',
            input: { platform: this.displayName, account: echoed },
          },
        }),
      );
    }
    return ok(account);
  }

  /**
   * Delegates to the injected source.
   *
   * The `try` is not redundant even though `FxTwitterTimelineSource`
   * already returns a `Result`: `source` is a public injection seam, and
   * {@link FeedPlatform} promises callers that every failure arrives on
   * the Err rail. Without this, a source that rejects would surface as
   * an unhandled rejection inside a background poll loop. The `await` is
   * load-bearing — returning the promise directly would leave the
   * `catch` unreachable.
   */
  public async fetchTimeline(
    account: string,
    options?: FeedTimelineFetchOptions,
  ): Promise<Result<readonly FeedPost[], FeedFailure>> {
    try {
      return await this.source.fetchTimeline(account, options);
    } catch (e: unknown) {
      return err(translateFeedError(this.displayName, account, e));
    }
  }

  /** Ascending (oldest-first) order, so a channel reads chronologically. */
  public compareIds(a: string, b: string): number {
    const left = toBigIntOrNull(a);
    const right = toBigIntOrNull(b);
    if (left === null || right === null) return 0;
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }

  /**
   * The lowest id a post created at `atMs` could carry.
   *
   * Anchors a cursor when there is no real post to anchor on — an
   * account whose timeline reads empty on the first pass. A plain `'0'`
   * would be below *every* post ever published, so the next full sweep
   * (which drops the `since` hint and returns the whole page) would treat
   * the account's entire back catalogue as new and drain it into the
   * channel. A time-derived floor is above everything already published
   * and below everything published afterwards, which is exactly the
   * no-backfill semantics a fresh subscription is supposed to establish.
   *
   * Clamped at zero so a badly-wrong system clock degrades to the old
   * permissive floor rather than producing a negative id.
   */
  public baselineIdAt(nowMs: number): string {
    if (nowMs <= SNOWFLAKE_EPOCH_MS) return '0';
    return (
      (BigInt(Math.floor(nowMs)) - BigInt(SNOWFLAKE_EPOCH_MS)) <<
      SNOWFLAKE_TIMESTAMP_SHIFT
    ).toString();
  }

  /**
   * Swap the host of the canonical permalink for the embed proxy.
   *
   * Rewriting the upstream-supplied URL (rather than rebuilding one from
   * parts) keeps the path exactly as the source reported it. Returns the
   * original URL when it cannot be parsed, so a malformed permalink
   * still posts something useful instead of nothing.
   */
  public toEmbedUrl(post: FeedPost): string {
    try {
      const url = new URL(post.url);
      // An invalid hostname is silently ignored by the URL setter, which
      // leaves the original host in place — the safe direction.
      url.hostname = this.embedProxyHost;
      return url.toString();
    } catch {
      return post.url;
    }
  }
}
