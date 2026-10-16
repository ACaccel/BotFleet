/**
 * Reads an account's recent posts from an FxTwitter-compatible JSON API
 * (`GET {base}/2/profile/{account}/statuses`).
 *
 * X's official API has no free tier and bills per post read, which a
 * five-minute poller cannot justify. The risk of a community-run upstream is
 * contained by the {@link XTimelineSource} seam, a self-hostable
 * `apiBaseUrl`, and the consuming plugin defaulting to disabled.
 *
 * Undocumented upstream behaviours, verified against the live API:
 *   - `count` is ignored; a full page (~20) always returns, so none is sent
 *     and the caller caps how many it acts on.
 *   - `since` gates the status code, it does not filter: nothing newer
 *     answers `204`, otherwise `200` with the whole page. De-duplication is
 *     the caller's job.
 *   - `since` is a strict `>`, so a post in the same second as the cursor
 *     stays hidden; the caller periodically re-reads without `since`.
 *   - Entries are not ordered by `created_timestamp` (a repost carries the
 *     original's timestamp), so callers sort defensively.
 *   - `404` with a JSON body means an unknown or renamed account;
 *     `validateStatus` below turns it into a thrown error for the taxonomy
 *     translator.
 */
import axios from 'axios';
import { z } from 'zod';

import { isRetryableError, retryFetch } from '../../../core/retry';
import { ok, err, type Result } from '../../../core/result';
import { invalidResponseError, translateFeedError } from './error-translator';
import { DEFAULT_X_API_BASE_URL, X_PLATFORM_DISPLAY_NAME, type XTimelineSource } from './x-types';
import type { FeedFailure, FeedPost, FeedPostMedia, FeedTimelineFetchOptions } from '../types';

/**
 * Identifies the bot to the upstream operator so a misbehaving poller
 * can be attributed and rate-limited rather than blanket-blocked. The
 * API needs no crawler-specific UA (unlike the OpenGraph probes in
 * `infra/link-preview`), so this one is descriptive rather than spoofed.
 */
const DEFAULT_USER_AGENT = 'Pleiades-social-feed/1.0 (+https://github.com/ACaccel/pleiades-fleet)';

/**
 * Response-body ceiling. A full page measures well under 100 kB; this
 * bounds memory if the upstream is replaced by something hostile or
 * broken without rejecting a legitimately large page.
 */
const MAX_CONTENT_LENGTH_BYTES = 4 * 1024 * 1024;

/** Bounded so a redirect loop cannot hold the poll open. */
const MAX_REDIRECTS = 2;

/**
 * Attempts per read, including the first.
 *
 * Deliberately smaller than the shared default (5): this runs inside a
 * poll loop that comes back in minutes, so a failure is cheap to defer
 * and a long retry chain only delays the remaining accounts.
 */
const RETRY_MAX_ATTEMPTS = 3;

/** First backoff wait; doubled after each retryable failure. */
const RETRY_INITIAL_DELAY_MS = 1000;

/** `204 No Content` — the upstream's "nothing newer than `since`" answer. */
const HTTP_NO_CONTENT = 204;

/** `429 Too Many Requests` — the upstream asking to be left alone. */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Narrower than the shared default: a 429 is not retried here.
 *
 * The generic predicate treats 429 as transient, which suits a client
 * whose library owns a rate-limit queue. This client talks straight to a
 * shared community host, so retrying would answer "you are sending too
 * much" by sending three times as much inside a few seconds. The poll
 * loop's own interval is the correct backoff.
 */
const isRetryableUpstreamFailure = (error: unknown): boolean => {
  if (!isRetryableError(error)) return false;
  const status = (error as { response?: { status?: unknown } } | undefined)?.response?.status;
  return status !== HTTP_TOO_MANY_REQUESTS;
};

/**
 * Media entries carry far more than a URL (dimensions, alt text, encoded
 * variants); `.passthrough()` keeps validation to what is consumed so an
 * upstream field addition cannot fail the parse.
 */
const MediaItemSchema = z.object({ url: z.string().min(1) }).passthrough();

const MediaSchema = z
  .object({
    photos: z.array(MediaItemSchema).optional(),
    videos: z.array(MediaItemSchema).optional(),
  })
  .passthrough();

const StatusSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1),
    created_timestamp: z.number(),
    author: z.object({ screen_name: z.string().min(1) }).passthrough(),
    // Optional *and* forgiving: no sample captured from this upstream
    // carries `text`, so demanding it would fail every page. `.catch`
    // additionally absorbs a `null` or a non-string, because a body the
    // feed only uses for keyword matching must never be able to fail the
    // whole entry closed — that would read as a permanently broken feed.
    text: z.string().nullish().catch(undefined),
    // Absent for a text-only post, and `{}` rather than null when the
    // post has no media at all.
    media: MediaSchema.optional(),
    // Both are objects when set and `null` otherwise; only their
    // presence is consumed, so the payload shape is left unvalidated.
    replying_to: z.unknown().optional(),
    reposted_by: z.unknown().optional(),
  })
  .passthrough();

/**
 * Envelope only. Entries are validated one at a time so an unrecognised
 * entry kind (the API can also emit grouped threads) is skipped instead
 * of failing the whole page.
 */
const TimelineResponseSchema = z.object({ results: z.array(z.unknown()) }).passthrough();

type RawStatus = z.infer<typeof StatusSchema>;

const isPresent = (value: unknown): boolean => value !== null && value !== undefined;

const mediaOf = (raw: RawStatus): readonly FeedPostMedia[] => {
  const photos = raw.media?.photos ?? [];
  const videos = raw.media?.videos ?? [];
  return [
    ...photos.map((p): FeedPostMedia => ({ kind: 'photo', url: p.url })),
    ...videos.map((v): FeedPostMedia => ({ kind: 'video', url: v.url })),
  ];
};

const toPost = (raw: RawStatus): FeedPost => ({
  id: raw.id,
  authorAccount: raw.author.screen_name,
  createdTimestamp: raw.created_timestamp,
  url: raw.url,
  text: raw.text ?? '',
  isReply: isPresent(raw.replying_to),
  isRepost: isPresent(raw.reposted_by),
  media: mediaOf(raw),
});

/** Construction-time settings for {@link FxTwitterTimelineSource}. */
interface FxTwitterTimelineSourceOptions {
  /** API origin, without a trailing slash. Defaults to the public host. */
  readonly apiBaseUrl?: string;
  /** Per-request hard timeout, in milliseconds. */
  readonly timeoutMs: number;
  /** Overridable for tests and for operators who must identify differently. */
  readonly userAgent?: string;
}

export class FxTwitterTimelineSource implements XTimelineSource {
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;

  public constructor(private readonly options: FxTwitterTimelineSourceOptions) {
    // Trailing slashes would produce `//2/profile/...`, which some
    // reverse proxies in front of a self-hosted instance reject.
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_X_API_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  /**
   * Read `account`'s recent posts. Never throws: every failure mode
   * (timeout, HTTP error, unknown account, malformed body) is mapped
   * onto the Result's error channel so the caller's poll loop stays
   * alive.
   */
  public async fetchTimeline(
    account: string,
    options: FeedTimelineFetchOptions = {},
  ): Promise<Result<readonly FeedPost[], FeedFailure>> {
    const url = `${this.apiBaseUrl}/2/profile/${encodeURIComponent(account)}/statuses`;
    try {
      // A transient blip (502, dropped socket) is worth one more try
      // rather than leaving the account unread until the next pass;
      // `retryFetch` reruns only on retryable shapes, so a 404 or 400
      // still fails immediately. Each attempt gets a fresh deadline.
      const res = await retryFetch(
        async () =>
          axios.get(url, {
            timeout: this.options.timeoutMs,
            // axios's `timeout` is an inactivity timer, not a deadline: a
            // response that trickles a byte at a time resets it forever
            // and would wedge the serial poll loop. The signal is the
            // absolute cap that actually bounds a pass.
            signal: AbortSignal.timeout(this.options.timeoutMs),
            headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
            // `since` omitted entirely when absent: the upstream rejects a
            // non-numeric value with 400, and an empty string is non-numeric.
            params: options.sinceTimestamp === undefined ? {} : { since: options.sinceTimestamp },
            maxRedirects: MAX_REDIRECTS,
            maxContentLength: MAX_CONTENT_LENGTH_BYTES,
            // 204 is a success ("nothing newer"); everything except 200/204
            // — 400, 404, 5xx — must throw so it reaches the translator.
            validateStatus: (status: number): boolean =>
              status === 200 || status === HTTP_NO_CONTENT,
          }),
        {
          maxAttempts: RETRY_MAX_ATTEMPTS,
          initialDelayMs: RETRY_INITIAL_DELAY_MS,
          shouldRetry: isRetryableUpstreamFailure,
        },
      );
      if (res.status === HTTP_NO_CONTENT) return ok([]);
      return this.parseTimeline(account, res.data);
    } catch (e: unknown) {
      return err(translateFeedError(X_PLATFORM_DISPLAY_NAME, account, e));
    }
  }

  /**
   * Validate the envelope, then each entry independently.
   *
   * A page that holds entries but yields no recognisable post is treated
   * as an error rather than as "nothing new": that shape means the
   * upstream schema moved, and reporting it as an empty timeline would
   * leave the feed silently dead for as long as the drift lasts.
   */
  private parseTimeline(account: string, body: unknown): Result<readonly FeedPost[], FeedFailure> {
    const envelope = TimelineResponseSchema.safeParse(body);
    if (!envelope.success) {
      return err(invalidResponseError(X_PLATFORM_DISPLAY_NAME, account, envelope.error));
    }

    const posts: FeedPost[] = [];
    // Kept so the "nothing parsed" error below can name what actually
    // went wrong. Reporting a bare INVALID_RESPONSE with no cause turns
    // a schema drift into a blind diagnosis.
    let firstEntryError: unknown;
    for (const entry of envelope.data.results) {
      const status = StatusSchema.safeParse(entry);
      if (status.success) {
        posts.push(toPost(status.data));
      } else {
        firstEntryError ??= status.error;
      }
    }
    if (envelope.data.results.length > 0 && posts.length === 0) {
      return err(invalidResponseError(X_PLATFORM_DISPLAY_NAME, account, firstEntryError));
    }
    return ok(posts);
  }
}
