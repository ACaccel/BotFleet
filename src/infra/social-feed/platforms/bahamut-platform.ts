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
import {
  parseBahamutBoardPage,
  parseBahamutPage,
  readBahamutAttribute,
  type BahamutPage,
  type BahamutTopic,
} from './bahamut-html';
import { canonicalBahamutTarget, parseBahamutTarget, type BahamutTarget } from './bahamut-target';
import { invalidResponseError, translateFeedError } from './error-translator';

export const DEFAULT_BAHAMUT_BASE_URL = 'https://forum.gamer.com.tw';
const OPERATION = 'BahamutPlatform.fetchTimeline';
const CURSOR = /^\d+:\d+$/;
const MAX_BATCH_SIZE = 20;

interface BahamutPlatformOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxPages: number;
}

export class BahamutPlatform implements FeedPlatform {
  public readonly id = 'bahamut';
  public readonly displayName = FEED_PLATFORM_DISPLAY_NAMES.bahamut;
  public readonly subscriptionScope = 'source';
  public readonly supportsCursorPagination = true;
  public readonly defaultMediaFilter = 'any';

  public constructor(private readonly options: BahamutPlatformOptions) {}

  public async normalizeAccount(raw: string): Promise<Result<string, FeedFailure>> {
    const parsed = parseBahamutTarget(raw);
    if (!parsed.ok) return parsed;
    if (parsed.value.kind !== 'floor') return ok(canonicalBahamutTarget(parsed.value));
    const { board, post } = parsed.value;
    try {
      const html = await this.readHtml(
        '/Co.php',
        { bsn: board, sn: post },
        AbortSignal.timeout(this.options.timeoutMs),
      );
      for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
        if (readBahamutAttribute(tag[0], 'property') !== 'al:ios:url') continue;
        const value = readBahamutAttribute(tag[0], 'content');
        if (value === undefined) continue;
        const url = new URL(value);
        const thread = url.searchParams.get('snA');
        if (
          url.protocol === 'bahamut:' &&
          url.searchParams.get('bsn') === board &&
          thread !== null &&
          /^[1-9]\d{0,9}$/.test(thread)
        ) {
          return ok(`${board}/${thread}`);
        }
      }
      return err(
        invalidResponseError(
          this.displayName,
          raw,
          new Error('Missing parent thread metadata'),
          OPERATION,
        ),
      );
    } catch (cause: unknown) {
      return err(translateFeedError(this.displayName, raw, cause, OPERATION));
    }
  }

  public async fetchTimeline(
    account: string,
    options: FeedTimelineFetchOptions = {},
  ): Promise<Result<readonly FeedPost[], FeedFailure>> {
    try {
      const normalized = await this.normalizeAccount(account);
      if (!normalized.ok) return normalized;
      const parsed = parseBahamutTarget(normalized.value);
      if (!parsed.ok) return parsed;
      if (parsed.value.kind === 'floor')
        return err(invalidResponseError(this.displayName, account, undefined, OPERATION));
      if (options.afterId !== undefined && !CURSOR.test(options.afterId)) {
        return err(
          invalidResponseError(
            this.displayName,
            account,
            new Error('Invalid source cursor'),
            OPERATION,
          ),
        );
      }
      const signal = AbortSignal.timeout(this.options.timeoutMs);
      const posts =
        parsed.value.kind === 'board'
          ? await this.readBoard(parsed.value, options, signal)
          : await this.readThread(parsed.value, options, signal);
      return ok(posts);
    } catch (cause: unknown) {
      return err(
        cause instanceof FeedError
          ? cause
          : translateFeedError(this.displayName, account, cause, OPERATION),
      );
    }
  }

  private async readHtml(
    path: string,
    params: Readonly<Record<string, string | number>>,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await boundedHttp.get<unknown>(
      `${this.options.baseUrl.replace(/\/+$/, '')}${path}`,
      {
        params,
        signal,
        timeout: this.options.timeoutMs,
        maxContentLength: 4 * 1024 * 1024,
        maxRedirects: 0,
        responseType: 'text',
        headers: {
          'User-Agent': 'Pleiades-social-feed/1.0 (+https://github.com/ACaccel/pleiades-fleet)',
          Accept: 'text/html',
          ...(path === '/B.php' ? { Cookie: 'ckForumListOrder=post' } : {}),
        },
      },
    );
    if (typeof response.data !== 'string')
      throw invalidResponseError(this.displayName, path, undefined, OPERATION);
    return response.data;
  }

  private parseThread(
    html: string,
    target: Extract<BahamutTarget, { kind: 'thread' }>,
  ): BahamutPage {
    try {
      return parseBahamutPage(html, canonicalBahamutTarget(target));
    } catch (cause: unknown) {
      throw invalidResponseError(
        this.displayName,
        canonicalBahamutTarget(target),
        cause,
        OPERATION,
      );
    }
  }

  private async readThread(
    target: Extract<BahamutTarget, { kind: 'thread' }>,
    options: FeedTimelineFetchOptions,
    signal: AbortSignal,
  ): Promise<readonly FeedPost[]> {
    const read = async (page: number): Promise<BahamutPage> =>
      this.parseThread(
        await this.readHtml('/C.php', { bsn: target.board, snA: target.thread, page }, signal),
        target,
      );
    const first = await read(1);
    let number = first.lastPage;
    let page = number === 1 ? first : await read(number);
    // A read without a cursor is a baseline lookup, never a replay request.
    if (options.afterId === undefined) return page.posts;
    const afterId = options.afterId;
    const posts = new Map<string, FeedPost>();
    for (let count = 0; count < this.options.maxPages; count++) {
      for (const post of page.posts)
        if (this.compareIds(post.id, afterId) > 0) posts.set(post.id, post);
      if (number <= 1 || page.posts.some((post) => this.compareIds(post.id, afterId) <= 0)) {
        return this.oldestBatch([...posts.values()], options.limit);
      }
      if (count + 1 === this.options.maxPages)
        throw this.lookbackError(canonicalBahamutTarget(target));
      number--;
      page = number === 1 ? first : await read(number);
    }
    return [];
  }

  private async readBoard(
    target: Extract<BahamutTarget, { kind: 'board' }>,
    options: FeedTimelineFetchOptions,
    signal: AbortSignal,
  ): Promise<readonly FeedPost[]> {
    const key = canonicalBahamutTarget(target);
    let checkpointTimestamp =
      options.afterId === undefined
        ? Math.floor(Date.now() / 1000)
        : Number(options.afterId.split(':')[0]);
    const afterTopic = options.afterId?.split(':')[1];
    const topics = new Map<string, BahamutTopic>();
    for (let number = 1; number <= this.options.maxPages; number++) {
      const html = await this.readHtml(
        '/B.php',
        {
          bsn: target.board,
          page: number,
          ...(target.subboard === undefined ? {} : { subbsn: target.subboard }),
        },
        signal,
      );
      let page;
      try {
        page = parseBahamutBoardPage(html, target);
      } catch (cause: unknown) {
        throw invalidResponseError(this.displayName, key, cause, OPERATION);
      }
      for (const topic of page.topics) {
        if (afterTopic === undefined || BigInt(topic.id) > BigInt(afterTopic))
          topics.set(topic.id, topic);
      }
      if (
        afterTopic === undefined ||
        number >= page.lastPage ||
        page.topics.some((topic) => !topic.sticky && BigInt(topic.id) <= BigInt(afterTopic))
      )
        break;
      if (number === this.options.maxPages) throw this.lookbackError(key);
    }
    const ordered = [...topics.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
    );
    const selected =
      afterTopic === undefined
        ? ordered.slice(-1)
        : ordered.slice(0, this.batchSize(options.limit));
    const posts: FeedPost[] = [];
    for (const topic of selected) {
      const thread = { kind: 'thread', board: target.board, thread: topic.id } as const;
      const page = this.parseThread(
        await this.readHtml('/C.php', { bsn: target.board, snA: topic.id, page: 1 }, signal),
        thread,
      );
      const opening = page.posts.find((post) => post.floorNumber === 1);
      if (opening === undefined && page.deletedFloors.some((floor) => floor.floorNumber === 1)) {
        // A deleted opening floor must not block later topics. Keep a non-deliverable
        // checkpoint at the preceding source time instead of using a later reply's time.
        posts.push({
          id: `${checkpointTimestamp}:${topic.id}`,
          createdTimestamp: checkpointTimestamp,
          authorAccount: '',
          text: '',
          media: [],
          isReply: false,
          isRepost: false,
          isDeleted: true,
          url: `https://forum.gamer.com.tw/C.php?bsn=${target.board}&snA=${topic.id}`,
        });
        continue;
      }
      if (opening === undefined)
        throw invalidResponseError(
          this.displayName,
          key,
          new Error('Missing opening floor'),
          OPERATION,
        );
      posts.push({
        ...opening,
        id: `${opening.createdTimestamp}:${topic.id}`,
        text: `${topic.title}\n${opening.text}`,
        url: `https://forum.gamer.com.tw/C.php?bsn=${target.board}&snA=${topic.id}`,
        isReply: false,
      });
      checkpointTimestamp = opening.createdTimestamp;
    }
    return this.oldestBatch(posts, options.limit);
  }

  private lookbackError(account: string): FeedFailure {
    return new FeedError({
      code: 'FEED_FETCH_FAILED',
      messageKey: 'errors:feed.bahamut_lookback_exceeded',
      messageParams: { platform: this.displayName, account, status: String(this.options.maxPages) },
      context: { operation: OPERATION, input: { account, maxPages: this.options.maxPages } },
    });
  }

  private batchSize(limit = MAX_BATCH_SIZE): number {
    return Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(limit)))
      : MAX_BATCH_SIZE;
  }

  private oldestBatch(posts: readonly FeedPost[], limit?: number): readonly FeedPost[] {
    return [...posts].sort((a, b) => this.compareIds(a.id, b.id)).slice(0, this.batchSize(limit));
  }

  public compareIds(a: string, b: string): number {
    if (!CURSOR.test(a) || !CURSOR.test(b)) return 0;
    const left = a.split(':').map(BigInt);
    const right = b.split(':').map(BigInt);
    for (const index of [0, 1]) {
      const l = left[index];
      const r = right[index];
      if (l === undefined || r === undefined) return 0;
      if (l < r) return -1;
      if (l > r) return 1;
    }
    return 0;
  }

  public baselineIdAt(nowMs: number): string {
    return `${Math.max(0, Math.floor(nowMs / 1000))}:0`;
  }

  public toEmbedUrl(post: FeedPost): string {
    return post.url;
  }
}
