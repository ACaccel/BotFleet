import { FeedError } from '../../../core/errors';
import { err, ok, type Result } from '../../../core/result';
import { boundedHttp } from '../../http';
import {
  FEED_PLATFORM_DISPLAY_NAMES,
  type FeedFailure,
  type FeedPlatform,
  type FeedPost,
  type FeedTimelineFetchOptions,
} from '../types';
import { invalidResponseError, translateFeedError } from './error-translator';
import { parseYouTubeAtom } from './youtube-atom';
import {
  parseYouTubeTarget,
  resolveYouTubeChannelMetadata,
  type YouTubeTarget,
} from './youtube-target';

const ORIGIN = 'https://www.youtube.com';
const OPERATION = 'YouTubePlatform.fetchTimeline';
const MAX_BODY_BYTES = 1024 * 1024;

export interface YouTubePlatformOptions {
  readonly timeoutMs?: number;
}

export class YouTubePlatform implements FeedPlatform {
  public readonly id = 'youtube';
  public readonly displayName = FEED_PLATFORM_DISPLAY_NAMES.youtube;
  public readonly subscriptionScope = 'source';
  public readonly defaultMediaFilter = 'any';
  public readonly trackingMode = 'snapshot' as const;
  private readonly timeoutMs: number;

  public constructor(options: YouTubePlatformOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new TypeError('YouTube timeoutMs must be an integer between 1 and 60000');
  }

  public async normalizeAccount(raw: string): Promise<Result<string, FeedFailure>> {
    const parsed = parseYouTubeTarget(raw);
    if (!parsed.ok) return parsed;
    try {
      return ok(await this.resolveChannel(parsed.value, AbortSignal.timeout(this.timeoutMs), raw));
    } catch (cause: unknown) {
      return err(
        cause instanceof FeedError
          ? cause
          : translateFeedError(this.displayName, raw, cause, 'YouTubePlatform.normalizeAccount'),
      );
    }
  }

  public async fetchTimeline(
    account: string,
    _options: FeedTimelineFetchOptions = {},
  ): Promise<Result<readonly FeedPost[], FeedFailure>> {
    const parsed = parseYouTubeTarget(account);
    if (!parsed.ok) return parsed;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const channel = await this.resolveChannel(parsed.value, signal, account);
      const body = await this.read(`/feeds/videos.xml?channel_id=${channel}`, signal);
      try {
        // Returning the complete window is necessary for persistent snapshot de-duplication.
        return ok(parseYouTubeAtom(body, channel));
      } catch (cause: unknown) {
        return err(invalidResponseError(this.displayName, account, cause, OPERATION));
      }
    } catch (cause: unknown) {
      return err(
        cause instanceof FeedError
          ? cause
          : translateFeedError(this.displayName, account, cause, OPERATION),
      );
    }
  }

  private async resolveChannel(
    target: YouTubeTarget,
    signal: AbortSignal,
    raw: string,
  ): Promise<string> {
    if (target.kind === 'channel') return target.id;
    const body = await this.read(`/@${encodeURIComponent(target.handle)}`, signal);
    try {
      return resolveYouTubeChannelMetadata(body);
    } catch (cause: unknown) {
      throw invalidResponseError(this.displayName, raw, cause, 'YouTubePlatform.normalizeAccount');
    }
  }

  private async read(path: string, signal: AbortSignal): Promise<string> {
    const maxBytes = path.startsWith('/@') ? 4 * MAX_BODY_BYTES : MAX_BODY_BYTES;
    const response = await boundedHttp.get<unknown>(`${ORIGIN}${path}`, {
      signal,
      timeout: this.timeoutMs,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      responseType: 'text',
      headers: {
        Accept: 'application/atom+xml, text/html;q=0.8',
        'User-Agent': 'Pleiades-social-feed/1.0',
      },
    });
    if (typeof response.data !== 'string' || Buffer.byteLength(response.data, 'utf8') > maxBytes)
      throw invalidResponseError(this.displayName, path, undefined, OPERATION);
    return response.data;
  }

  /** Legacy interface shim; snapshot consumers must never infer chronology from video IDs. */
  public compareIds(a: string, b: string): number {
    return a === b ? 0 : a < b ? -1 : 1;
  }

  /** Legacy interface shim; an empty snapshot is represented by its persistent seen-ID set. */
  public baselineIdAt(_nowMs: number): string {
    return '';
  }

  public toEmbedUrl(post: FeedPost): string {
    return post.url;
  }
}
