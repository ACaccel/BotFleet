/**
 * Unit tests for {@link XPlatform} — the X-specific rules the rest of
 * the feed delegates: account spelling, snowflake ordering, the
 * clock-derived baseline id, and the embed-proxy rewrite. The timeline
 * client is injected, so nothing here touches the network.
 */
import { describe, expect, it, vi } from 'vitest';

import { XPlatform, type XTimelineSource } from '../../../../src/infra/social-feed';
import { X_PLATFORM_DISPLAY_NAME } from '../../../../src/infra/social-feed/platforms/x-types';
import { err, isErr, isOk, ok } from '../../../../src/core/result';
import { FeedError } from '../../../../src/core/errors';
import { buildFeedPost } from '../../../fixtures/social-feed/fake-platform';
import { invalidResponseError, type OgClient } from '../../../../src/infra/link-preview';

const EMBED_PROXY_HOST = 'fxtwitter.com';

/** A live sample; beyond `Number.MAX_SAFE_INTEGER`. */
const LIVE_POST_ID = '2092744659667673582';

const makePlatform = (source?: XTimelineSource): XPlatform =>
  new XPlatform({ timeoutMs: 8000, embedProxyHost: EMBED_PROXY_HOST, source });

describe('XPlatform.buildPreview', () => {
  const post = buildFeedPost({ id: '42', url: 'https://x.com/NASA/status/42' });
  const video = {
    videos: [
      {
        duration: 10,
        formats: [{ url: 'https://video.twimg.com/a.mp4', container: 'mp4', bitrate: 800_000 }],
      },
    ],
  };

  it.each([
    {
      name: 'photos',
      media: { photos: [{ url: 'https://pbs.twimg.com/a.jpg' }] },
      sensitive: false,
      apiFails: false,
      proxyVideo: false,
      proxyFails: false,
      kind: 'post',
    },
    {
      name: 'playable video proxy',
      media: video,
      sensitive: false,
      apiFails: false,
      proxyVideo: true,
      proxyFails: false,
      kind: 'rewritten-url',
    },
    {
      name: 'video upload fallback',
      media: video,
      sensitive: false,
      apiFails: false,
      proxyVideo: false,
      proxyFails: false,
      kind: 'post',
    },
    {
      name: 'sensitive post',
      media: {},
      sensitive: true,
      apiFails: false,
      proxyVideo: false,
      proxyFails: false,
      kind: 'rewritten-url',
    },
    {
      name: 'API failure',
      media: {},
      sensitive: false,
      apiFails: true,
      proxyVideo: false,
      proxyFails: false,
      kind: 'rewritten-url',
    },
    {
      name: 'all preview sources unavailable',
      media: {},
      sensitive: false,
      apiFails: true,
      proxyVideo: false,
      proxyFails: true,
      kind: undefined,
    },
    {
      name: 'sensitive post without a proxy',
      media: {},
      sensitive: true,
      apiFails: false,
      proxyVideo: false,
      proxyFails: true,
      kind: undefined,
    },
  ])('uses the shared hybrid policy for $name', async (scenario) => {
    const fetchJson = vi.fn().mockResolvedValue(
      scenario.apiFails
        ? err(invalidResponseError('twitter'))
        : ok({
            status: {
              url: post.url,
              text: 'Post text',
              created_timestamp: 1,
              author: { name: 'NASA', screen_name: 'NASA' },
              media: scenario.media,
              possibly_sensitive: scenario.sensitive,
            },
          }),
    );
    const fetch = vi.fn().mockResolvedValue(
      scenario.proxyFails
        ? err(invalidResponseError('twitter'))
        : ok({
            images: ['https://pbs.twimg.com/a.jpg'],
            ...(scenario.proxyVideo ? { video: 'https://video.twimg.com/a.mp4' } : {}),
          }),
    );
    const platform = new XPlatform({
      apiBaseUrl: 'https://api.example',
      timeoutMs: 1234,
      embedProxyHost: 'vx.example',
      ogClient: { fetch, fetchJson } as unknown as OgClient,
    });
    const result = await platform.buildPreview(post);
    if (!result.ok) throw new Error('expected a preview result');
    expect(result.value?.kind).toBe(scenario.kind);
    expect(fetchJson).toHaveBeenCalledWith('https://api.example/2/status/42', 'twitter', 1234);
    if (
      scenario.kind === 'rewritten-url' ||
      scenario.apiFails ||
      scenario.sensitive ||
      scenario.media === video
    ) {
      expect(fetch).toHaveBeenCalledWith('https://vx.example/NASA/status/42', 'twitter', 1234);
    } else {
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(['not-a-url', 'https://evil.example/NASA/status/42', 'https://x.com/NASA'])(
    'rejects an unmatched permalink (%s)',
    async (url) => {
      const fetchJson = vi.fn();
      const platform = new XPlatform({
        timeoutMs: 1000,
        embedProxyHost: EMBED_PROXY_HOST,
        ogClient: { fetchJson } as unknown as OgClient,
      });
      expect((await platform.buildPreview({ ...post, url })).ok).toBe(false);
      expect(fetchJson).not.toHaveBeenCalled();
    },
  );
});

describe('XPlatform.normalizeAccount', () => {
  it.each([
    ['@SomeAccount', 'someaccount'],
    ['SomeAccount', 'someaccount'],
    ['  @someaccount  ', 'someaccount'],
    ['a_1', 'a_1'],
    ['abcdefghijklmno', 'abcdefghijklmno'],
  ])('normalises %s to %s', (raw, expected) => {
    const result = makePlatform().normalizeAccount(raw);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(expected);
  });

  it.each([
    ['a dash', 'has-dash'],
    ['sixteen characters', 'toolonghandle123'],
    ['the empty string', ''],
    ['an inner space', 'has space'],
    ['a bare at-sign', '@'],
    ['a URL', 'https://x.com/someaccount'],
  ])('rejects %s', (_label, raw) => {
    const result = makePlatform().normalizeAccount(raw);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('FEED_INVALID_ACCOUNT');
    expect(result.error.messageKey).toBe('errors:feed.invalid_account');
    // The raw input is echoed back so the user sees what was rejected,
    // minus a leading `@` the catalog template writes itself.
    expect(result.error.messageParams.account).toBe(raw.replace(/^@+/, ''));
    expect(result.error.messageParams.platform).toBe(X_PLATFORM_DISPLAY_NAME);
  });
});

describe('XPlatform.compareIds', () => {
  it('orders 64-bit ids that `Number` would collapse', () => {
    const platform = makePlatform();
    const older = '2092744659667673581';

    expect(platform.compareIds(older, LIVE_POST_ID)).toBeLessThan(0);
    expect(platform.compareIds(LIVE_POST_ID, older)).toBeGreaterThan(0);
    expect(platform.compareIds(LIVE_POST_ID, LIVE_POST_ID)).toBe(0);
  });

  it('sorts a page ascending', () => {
    const platform = makePlatform();
    const ids = ['2092744659667673582', '2092205524481667467', '2092613031897231635'];

    expect([...ids].sort((a, b) => platform.compareIds(a, b))).toEqual([
      '2092205524481667467',
      '2092613031897231635',
      '2092744659667673582',
    ]);
  });

  it.each([
    ['a non-numeric left id', 'not-a-number', LIVE_POST_ID],
    ['a non-numeric right id', LIVE_POST_ID, 'not-a-number'],
    ['a fractional id', '12.5', LIVE_POST_ID],
  ])('reports %s as equal rather than throwing', (_label, a, b) => {
    // An upstream id-format change must degrade to "leave the order
    // alone", not crash the background poll loop.
    expect(makePlatform().compareIds(a, b)).toBe(0);
  });

  it.each([
    ['an empty id', ''],
    ['a whitespace id', ' '],
  ])('treats %s as the lowest value rather than as unparseable', (_label, id) => {
    // `BigInt('')` and `BigInt(' ')` are both `0n`. Sorting those below
    // every real post is the safe direction: a cursor that low forwards,
    // never skips.
    expect(makePlatform().compareIds(id, LIVE_POST_ID)).toBeLessThan(0);
  });
});

describe('XPlatform.baselineIdAt', () => {
  it('clamps a time before the snowflake epoch to zero', () => {
    expect(makePlatform().baselineIdAt(0)).toBe('0');
    expect(makePlatform().baselineIdAt(1_288_834_974_657)).toBe('0');
  });

  it('produces an id that sorts above an existing post', () => {
    const platform = makePlatform();
    // The live sample was created in 2026; a 2027 baseline must be newer.
    const baseline = platform.baselineIdAt(Date.UTC(2027, 0, 1));

    expect(platform.compareIds(LIVE_POST_ID, baseline)).toBeLessThan(0);
  });

  it('sits below a post published after it', () => {
    // The other half of the contract. Pinned against the live sample's
    // own creation time, so widening the shift or moving the epoch — a
    // change that would make a fresh subscription skip real posts —
    // fails here rather than shipping.
    const platform = makePlatform();
    const floorAtSampleTime = platform.baselineIdAt(1787784182 * 1000);

    expect(platform.compareIds(floorAtSampleTime, LIVE_POST_ID)).toBeLessThan(0);
  });

  it('is monotonic in time', () => {
    const platform = makePlatform();
    const earlier = platform.baselineIdAt(Date.UTC(2026, 0, 1));
    const later = platform.baselineIdAt(Date.UTC(2026, 0, 2));

    expect(platform.compareIds(earlier, later)).toBeLessThan(0);
  });
});

describe('XPlatform.toEmbedUrl', () => {
  it('swaps the host and leaves the path untouched', () => {
    const post = buildFeedPost({
      id: LIVE_POST_ID,
      url: `https://x.com/someaccount/status/${LIVE_POST_ID}`,
    });

    expect(makePlatform().toEmbedUrl(post)).toBe(
      `https://${EMBED_PROXY_HOST}/someaccount/status/${LIVE_POST_ID}`,
    );
  });

  it('preserves the query string and fragment', () => {
    const post = buildFeedPost({ id: '1', url: 'https://x.com/a/status/1?s=20#frag' });

    expect(makePlatform().toEmbedUrl(post)).toBe(
      `https://${EMBED_PROXY_HOST}/a/status/1?s=20#frag`,
    );
  });

  it('returns an unparseable URL unchanged', () => {
    // Posting the original link beats posting nothing.
    const post = buildFeedPost({ id: '1', url: 'not a url' });

    expect(makePlatform().toEmbedUrl(post)).toBe('not a url');
  });
});

describe('XPlatform.fetchTimeline', () => {
  it('delegates to the injected source, passing the options through', async () => {
    const posts = [buildFeedPost({ id: '1' })];
    const fetchTimeline = vi.fn(async () => ok(posts));
    const source: XTimelineSource = { fetchTimeline };
    const platform = makePlatform(source);

    const result = await platform.fetchTimeline('someaccount', { sinceTimestamp: 42 });

    expect(fetchTimeline).toHaveBeenCalledWith('someaccount', { sinceTimestamp: 42 });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(posts);
  });

  it('passes an Err from the source straight through', async () => {
    const failure = new FeedError({
      code: 'FEED_NOT_FOUND',
      messageKey: 'errors:feed.not_found',
      messageParams: { platform: X_PLATFORM_DISPLAY_NAME, account: 'someaccount', status: '404' },
      context: { operation: 'test' },
    });
    const source: XTimelineSource = { fetchTimeline: vi.fn(async () => err(failure)) };

    const result = await makePlatform(source).fetchTimeline('someaccount');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe(failure);
  });

  it('converts a rejecting source into an Err rather than an unhandled rejection', async () => {
    // `source` is a public injection seam, and FeedPlatform promises the
    // caller that every failure arrives on the Err rail; a poll loop must
    // not have to guard each platform with its own try/catch.
    const source: XTimelineSource = {
      fetchTimeline: vi.fn(async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      }),
    };

    const result = await makePlatform(source).fetchTimeline('someaccount');

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('FEED_NOT_FOUND');
    expect(result.error.messageParams.platform).toBe(X_PLATFORM_DISPLAY_NAME);
    expect(result.error.messageParams.account).toBe('someaccount');
  });
});

describe('XPlatform.normalizeAccount error payload', () => {
  it('truncates and defuses the rejected input it quotes back', () => {
    // The value is interpolated into a Discord reply without escaping,
    // so backticks and newlines must not survive and the length must be
    // bounded regardless of what the user typed.
    const result = makePlatform().normalizeAccount(`\`\`\`inject\n${'x'.repeat(200)}`);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    const echoed = result.error.messageParams.account ?? '';
    expect(echoed).not.toMatch(/[`\r\n]/);
    expect(echoed.length).toBeLessThanOrEqual(32);
  });

  it('records the operation and omits a status it never had', () => {
    const result = makePlatform().normalizeAccount('has-dash');

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.context.operation).toBe('XPlatform.normalizeAccount');
    // No request was sent, and the catalog entry has no {{status}} slot.
    expect(result.error.messageParams.status).toBeUndefined();
  });

  it('strips repeated leading at-signs', () => {
    const result = makePlatform().normalizeAccount('@@someaccount');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('someaccount');
  });
});
