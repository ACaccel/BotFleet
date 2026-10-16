/**
 * Unit tests for {@link FxTwitterTimelineSource}. axios is auto-mocked so
 * the tests drive the request/response and failure-mapping logic without
 * a network. Each case reassigns `axios.get` (the `selfhosted-client`
 * pattern) to control the resolved/rejected value.
 *
 * The fixtures below mirror shapes observed on the live API — notably a
 * repost carrying the *original* author and id, an empty `media: {}` on
 * a text-only post, and post ids beyond `Number.MAX_SAFE_INTEGER`.
 */
import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { FxTwitterTimelineSource } from '../../../../src/infra/social-feed';
import { isErr, isOk } from '../../../../src/core/result';

import { X_PLATFORM_DISPLAY_NAME } from '../../../../src/infra/social-feed/platforms/x-types';

vi.mock('axios');

const BASE_URL = 'https://api.example.invalid';
const TIMEOUT_MS = 8000;
const ACCOUNT = 'someaccount';
/** Display name the source stamps onto every error it emits. */
const PLATFORM = X_PLATFORM_DISPLAY_NAME;

const makeSource = (): FxTwitterTimelineSource =>
  new FxTwitterTimelineSource({ apiBaseUrl: BASE_URL, timeoutMs: TIMEOUT_MS });

const setGet = (impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> => {
  const get = vi.fn(impl);
  (axios.get as unknown as ReturnType<typeof vi.fn>) = get;
  return get;
};

/**
 * Run a call whose failure is retryable. The client retries with backoff,
 * so real timers would make each of these cases sleep for seconds; fake
 * timers keep them instant while still exercising the retry path.
 */
const withBackoffSkipped = async <T>(run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(60_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
};

/** A photo post authored by the followed account. */
const photoStatus = {
  id: '2092744659667673582',
  url: 'https://x.com/someaccount/status/2092744659667673582',
  created_timestamp: 1787784182,
  author: { screen_name: 'someaccount', name: 'Some Account' },
  media: {
    all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
    photos: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1920, height: 1080 },
    ],
  },
  replying_to: null,
  reposted_by: null,
  likes: 12,
};

/** A video post; `formats` is extra data the schema must tolerate. */
const videoStatus = {
  id: '2092721435663798658',
  url: 'https://x.com/someaccount/status/2092721435663798658',
  created_timestamp: 1787778645,
  author: { screen_name: 'someaccount' },
  media: {
    videos: [
      {
        url: 'https://video.twimg.com/amplify_video/1/vid.mp4',
        thumbnail_url: 'https://pbs.twimg.com/media/t.jpg',
        duration: 32.1,
        formats: [{ url: 'https://video.twimg.com/pl.m3u8', container: 'm3u8' }],
      },
    ],
  },
  replying_to: null,
  reposted_by: null,
};

/** Text-only: the live API sends `media: {}` rather than omitting it. */
const textStatus = {
  id: '2092205524481667467',
  url: 'https://x.com/someaccount/status/2092205524481667467',
  created_timestamp: 1787655642,
  author: { screen_name: 'someaccount' },
  media: {},
  replying_to: null,
  reposted_by: null,
};

/** A repost: authored by someone else, surfaced on this account's timeline. */
const repostStatus = {
  id: '2092613031897231635',
  url: 'https://x.com/otheraccount/status/2092613031897231635',
  created_timestamp: 1787752800,
  author: { screen_name: 'otheraccount' },
  media: { videos: [{ url: 'https://video.twimg.com/x.mp4' }] },
  replying_to: null,
  reposted_by: { id: '1', name: 'Some Account', screen_name: 'someaccount' },
};

/** A self-thread continuation. */
const replyStatus = {
  id: '2092279559890567294',
  url: 'https://x.com/someaccount/status/2092279559890567294',
  created_timestamp: 1787673294,
  author: { screen_name: 'someaccount' },
  media: { photos: [{ url: 'https://pbs.twimg.com/media/r.jpg' }] },
  replying_to: { screen_name: 'someaccount', status: '2092279559890567290' },
  reposted_by: null,
};

/**
 * A post carrying a body. No capture of this upstream in the repo holds
 * `text`, so the field is treated as optional; this fixture pins what
 * happens when a deployment does return one.
 */
const captionedStatus = {
  id: '2092744659667673999',
  url: 'https://x.com/someaccount/status/2092744659667673999',
  created_timestamp: 1787784999,
  author: { screen_name: 'someaccount' },
  text: 'Chapter 12 is out now',
  media: { photos: [{ url: 'https://pbs.twimg.com/media/c.jpg' }] },
  replying_to: null,
  reposted_by: null,
};

const page = (results: readonly unknown[]): unknown => ({
  status: 200,
  data: { code: 200, results, cursor: { top: 'a', bottom: 'b' } },
});

describe('FxTwitterTimelineSource retry and deadline', () => {
  it('retries a transient upstream failure and succeeds on a later attempt', async () => {
    const get = setGet(async () => page([photoStatus]));
    get.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }),
    );

    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isOk(result)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('stops after the attempt ceiling rather than retrying forever', async () => {
    const get = setGet(async () => {
      throw Object.assign(new Error('Bad Gateway'), { response: { status: 502 } });
    });

    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isErr(result)).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 429 — answering "too many requests" with more requests', async () => {
    // The shared predicate treats 429 as transient, which suits a client
    // whose library owns a rate-limit queue. This one talks straight to a
    // free community host, so the poll interval is the right backoff.
    const get = setGet(async () => {
      throw Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    });

    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_RATE_LIMITED');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 404 - a renamed account stays broken until resubscribed', async () => {
    const get = setGet(async () => {
      throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
    });

    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400 — a rejected parameter will be rejected again', async () => {
    const get = setGet(async () => {
      throw Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    });

    await makeSource().fetchTimeline(ACCOUNT);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal as the absolute deadline alongside the idle timeout', async () => {
    // axios's `timeout` is an inactivity timer: a response that trickles
    // bytes resets it forever. The signal is what actually bounds a pass.
    const get = setGet(async () => page([]));
    await makeSource().fetchTimeline(ACCOUNT);

    const config = get.mock.calls[0]?.[1] as { timeout: number; signal: AbortSignal };
    expect(config.timeout).toBe(TIMEOUT_MS);
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps an aborted deadline to FEED_TIMEOUT', async () => {
    setGet(async () => {
      throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
    });

    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_TIMEOUT');
  });
});

describe('FxTwitterTimelineSource.fetchTimeline', () => {
  it('requests the profile statuses endpoint with the configured timeout', async () => {
    const get = setGet(async () => page([photoStatus]));
    await makeSource().fetchTimeline(ACCOUNT);

    expect(get).toHaveBeenCalledWith(
      `${BASE_URL}/2/profile/${ACCOUNT}/statuses`,
      expect.objectContaining({ timeout: TIMEOUT_MS }),
    );
  });

  it('omits the `since` parameter when no cursor timestamp is given', async () => {
    const get = setGet(async () => page([photoStatus]));
    await makeSource().fetchTimeline(ACCOUNT);

    expect(get).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ params: {} }));
  });

  it('sends `since` when a cursor timestamp is given', async () => {
    const get = setGet(async () => page([photoStatus]));
    await makeSource().fetchTimeline(ACCOUNT, { sinceTimestamp: 1787784182 });

    expect(get).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ params: { since: 1787784182 } }),
    );
  });

  it('percent-encodes the account so it cannot escape the path', async () => {
    const get = setGet(async () => page([]));
    await makeSource().fetchTimeline('a/../b');

    expect(get).toHaveBeenCalledWith(
      `${BASE_URL}/2/profile/a%2F..%2Fb/statuses`,
      expect.anything(),
    );
  });

  it('strips a trailing slash from the configured base URL', async () => {
    const get = setGet(async () => page([]));
    await new FxTwitterTimelineSource({
      apiBaseUrl: `${BASE_URL}/`,
      timeoutMs: TIMEOUT_MS,
    }).fetchTimeline(ACCOUNT);

    expect(get).toHaveBeenCalledWith(
      `${BASE_URL}/2/profile/${ACCOUNT}/statuses`,
      expect.anything(),
    );
  });

  it('treats 204 as an empty timeline rather than an error', async () => {
    setGet(async () => ({ status: 204, data: '' }));
    const result = await makeSource().fetchTimeline(ACCOUNT, { sinceTimestamp: 1 });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it('accepts only 200 and 204 as success statuses', async () => {
    const get = setGet(async () => page([]));
    await makeSource().fetchTimeline(ACCOUNT);

    const config = get.mock.calls[0]?.[1] as { validateStatus: (s: number) => boolean };
    expect(config.validateStatus(200)).toBe(true);
    expect(config.validateStatus(204)).toBe(true);
    expect([400, 404, 429, 500].map((s) => config.validateStatus(s))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('normalises a photo post, keeping the id as a string', async () => {
    setGet(async () => page([photoStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual([
      {
        id: '2092744659667673582',
        authorAccount: 'someaccount',
        createdTimestamp: 1787784182,
        url: 'https://x.com/someaccount/status/2092744659667673582',
        text: '',
        isReply: false,
        isRepost: false,
        media: [{ kind: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
      },
    ]);
  });

  it('preserves an id that exceeds Number.MAX_SAFE_INTEGER exactly', async () => {
    setGet(async () => page([photoStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // Round-tripping through `number` would corrupt this value.
    expect(result.value[0]?.id).toBe('2092744659667673582');
    expect(Number(result.value[0]?.id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it('flattens photos and videos into one media list', async () => {
    setGet(async () => page([videoStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value[0]?.media).toEqual([
      { kind: 'video', url: 'https://video.twimg.com/amplify_video/1/vid.mp4' },
    ]);
  });

  it('carries the post body through to `text`', async () => {
    setGet(async () => page([captionedStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value[0]?.text).toBe('Chapter 12 is out now');
  });

  it('reports an empty body, not undefined, when the upstream omits `text`', async () => {
    // Keyword filtering reads `text` on every post; an absent field must
    // narrow to "matches nothing", never fail the parse or the compare.
    setGet(async () => page([photoStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value[0]?.text).toBe('');
  });

  it('reports an empty media list for a text-only post', async () => {
    setGet(async () => page([textStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value[0]?.media).toEqual([]);
  });

  it('marks reposts and replies without dropping them', async () => {
    setGet(async () => page([repostStatus, replyStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The source stays neutral — classification is the caller's filter.
    expect(result.value.map((p) => [p.isRepost, p.isReply])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(result.value[0]?.authorAccount).toBe('otheraccount');
  });

  it('skips an unrecognised entry but keeps the recognisable ones', async () => {
    setGet(async () => page([{ type: 'thread', conversation_id: '1' }, photoStatus]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.map((p) => p.id)).toEqual([photoStatus.id]);
  });

  it('returns an empty timeline for an empty results array', async () => {
    setGet(async () => page([]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it('reports INVALID_RESPONSE when a non-empty page yields no usable entry', async () => {
    // Silently returning [] here would leave the feed dead without a signal.
    setGet(async () => page([{ type: 'thread' }, { type: 'thread' }]));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_INVALID_RESPONSE');
  });

  it('reports INVALID_RESPONSE when the envelope shape is wrong', async () => {
    setGet(async () => ({ status: 200, data: { code: 200 } }));
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('FEED_INVALID_RESPONSE');
      expect(result.error.messageKey).toBe('errors:feed.invalid_response');
    }
  });

  it('maps an axios timeout (ECONNABORTED) to FEED_TIMEOUT', async () => {
    setGet(async () => {
      throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    });
    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_TIMEOUT');
  });

  it('maps HTTP 404 to FEED_NOT_FOUND and names the account', async () => {
    setGet(async () => {
      throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
    });
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('FEED_NOT_FOUND');
      expect(result.error.messageParams).toEqual({
        platform: PLATFORM,
        account: ACCOUNT,
        status: '404',
      });
    }
  });

  it('maps HTTP 429 to FEED_RATE_LIMITED', async () => {
    setGet(async () => {
      throw Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    });
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_RATE_LIMITED');
  });

  it('maps HTTP 500 to FEED_UPSTREAM_5XX and preserves operation + cause', async () => {
    const cause = Object.assign(new Error('Server Error'), { response: { status: 500 } });
    setGet(async () => {
      throw cause;
    });
    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('FEED_UPSTREAM_5XX');
      expect(result.error.context.operation).toBe('FxTwitterTimelineSource.fetchTimeline');
      expect(result.error.cause).toBe(cause);
    }
  });

  it('maps a bare transport failure to FEED_FETCH_FAILED with a network label', async () => {
    setGet(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('FEED_FETCH_FAILED');
      expect(result.error.messageParams).toEqual({
        platform: PLATFORM,
        account: ACCOUNT,
        status: 'ENOTFOUND',
      });
    }
  });

  it('maps HTTP 400 (a rejected parameter) to FEED_FETCH_FAILED', async () => {
    setGet(async () => {
      throw Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    });
    const result = await makeSource().fetchTimeline(ACCOUNT);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('FEED_FETCH_FAILED');
  });

  it('labels a failure with no status and no code as `network`', async () => {
    setGet(async () => {
      throw new Error('socket hang up');
    });
    const result = await withBackoffSkipped(() => makeSource().fetchTimeline(ACCOUNT));

    expect(isErr(result)).toBe(true);
    if (isErr(result))
      expect(result.error.messageParams).toEqual({
        platform: PLATFORM,
        account: ACCOUNT,
        status: 'network',
      });
  });
});
