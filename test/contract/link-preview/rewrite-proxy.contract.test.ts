/**
 * Contract test for the rewrite-provider validation loop at the real HTTP
 * boundary (nock, real axios + OgClient). The four rewrite providers share
 * one loop, so Twitter stands in for all. Pins: video short-circuit, fall-
 * through on a failed host, `ok(null)` when nothing yields media, that the
 * wire follows a legit public redirect under the Discordbot UA, that a
 * redirect back to the source site is skipped whatever the source serves,
 * and that a redirect to an internal address (incl. IPv4-mapped IPv6) is
 * refused.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import {
  OgClient,
  createTwitterProvider,
  createFacebookProvider,
  createBilibiliProvider,
  createThreadsProvider,
} from '../../../src/infra/link-preview';
import { isOk } from '../../../src/core/result';
import type { LinkPreviewProvider, LinkPreviewResult } from '../../../src/infra/link-preview';

const HOSTS = ['fxtwitter.com', 'vxtwitter.com'];
const PATH = '/jack/status/20';
const TWEET = new URL(`https://x.com${PATH}`);
const fxUrl = `https://fxtwitter.com${PATH}`;
const vxUrl = `https://vxtwitter.com${PATH}`;

const ogHtml = (head: string): string =>
  `<!doctype html><html><head>${head}</head><body>x</body></html>`;
const VIDEO_HEAD = '<meta property="og:video:secure_url" content="https://cdn.example/v.mp4">';
const IMAGE_HEAD = '<meta property="og:image" content="https://cdn.example/i.jpg">';

const provider = (): LinkPreviewProvider =>
  createTwitterProvider({ proxyHosts: HOSTS, ogClient: new OgClient() });

const build = async (): Promise<string | null> => {
  const result = await provider().build(TWEET, { timeoutMs: 4000 });
  if (!isOk(result)) throw new Error('expected ok');
  if (result.value === null) return null;
  if (result.value.kind !== 'rewritten-url') throw new Error('expected rewritten-url');
  return result.value.url;
};

describe('rewrite-provider proxy validation contract', () => {
  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    // Every registered interceptor must be consumed — a leftover means the
    // probe sequence diverged from what the test expected.
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('short-circuits on the first host that serves og:video (second host never probed)', async () => {
    // Only the first host is stubbed; if the loop probed the second, nock
    // would throw "no match" — so this also proves the short-circuit.
    nock('https://fxtwitter.com').get(PATH).reply(200, ogHtml(VIDEO_HEAD));
    expect(await build()).toBe(fxUrl);
  });

  it('falls through a 5xx host to a later host with media', async () => {
    nock('https://fxtwitter.com').get(PATH).reply(503, 'down');
    nock('https://vxtwitter.com').get(PATH).reply(200, ogHtml(IMAGE_HEAD));
    expect(await build()).toBe(vxUrl);
  });

  it('returns null (posts nothing) when no host yields media', async () => {
    nock('https://fxtwitter.com').get(PATH).reply(200, ogHtml('<title>nope</title>'));
    nock('https://vxtwitter.com').get(PATH).reply(200, ogHtml('<title>nope</title>'));
    expect(await build()).toBeNull();
  });

  it('sends the Discordbot UA and follows a legit public redirect to obtain media', async () => {
    // Embed proxies (e.g. kkinstagram) 301 to a render host; we follow it
    // (as Discord does) and read the OG there, but still post the ORIGINAL
    // proxy URL — Discord re-fetches and follows the same chain.
    nock('https://fxtwitter.com', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(PATH)
      .reply(301, '', { Location: 'https://render.example.com/v/20' });
    nock('https://render.example.com').get('/v/20').reply(200, ogHtml(VIDEO_HEAD));
    expect(await build()).toBe(fxUrl);
  });

  it('refuses a redirect to an internal address (SSRF guard) and falls through', async () => {
    // A 3xx to a private/link-local target must be blocked, not chased; the
    // loop then falls through to the next host.
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: 'http://169.254.169.254/latest/meta-data/' });
    nock('https://vxtwitter.com').get(PATH).reply(200, ogHtml(VIDEO_HEAD));
    expect(await build()).toBe(vxUrl);
  });

  it('refuses an IPv4-mapped IPv6 redirect to the metadata service and falls through', async () => {
    // `::ffff:169.254.169.254` routes to the IPv4 metadata endpoint; the guard
    // must block it end-to-end (URL parser -> beforeRedirect), not just for
    // the dotted form.
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' });
    nock('https://vxtwitter.com').get(PATH).reply(200, ogHtml(VIDEO_HEAD));
    expect(await build()).toBe(vxUrl);
  });

  it('skips a proxy that redirects back to the source site, whatever the source serves us', async () => {
    // A proxy that cannot fetch the post 302s to the source. The probe then
    // reads the source's page from THIS host (a genuine image card here), but
    // Discord's crawler follows the same redirect from its own address and
    // gets a login wall — so the host is unusable and the loop moves on.
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: `https://x.com${PATH}` });
    nock('https://x.com').get(PATH).reply(200, ogHtml(IMAGE_HEAD));
    nock('https://vxtwitter.com').get(PATH).reply(200, ogHtml(VIDEO_HEAD));
    expect(await build()).toBe(vxUrl);
  });

  it('posts nothing when every proxy redirects back to the source site', async () => {
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: `https://x.com${PATH}` });
    nock('https://x.com').get(PATH).reply(200, ogHtml(IMAGE_HEAD));
    nock('https://vxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: `https://twitter.com${PATH}` });
    nock('https://twitter.com').get(PATH).reply(200, ogHtml(IMAGE_HEAD));
    expect(await build()).toBeNull();
  });

  it('treats a redirect straight to a video file as a playable preview (kkinstagram-style)', async () => {
    // Some proxies (e.g. kkinstagram) 302 the bot UA straight to a *.mp4 on a
    // CDN with no OpenGraph HTML; Discord follows the same redirect and embeds
    // the file. A `video/*` Content-Type is therefore a valid preview, and we
    // post the ORIGINAL proxy URL. Classification is from headers alone (that
    // the body is never buffered is pinned in the og-client unit test).
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: 'https://cdn.example.com/v/20.mp4' });
    nock('https://cdn.example.com')
      .get('/v/20.mp4')
      .reply(200, 'mp4-bytes', { 'Content-Type': 'video/mp4' });
    expect(await build()).toBe(fxUrl);
  });

  it('counts a video-file redirect as a hit even when the CDN is unreachable from the bot host', async () => {
    // The proxy 302s to a *.mp4, but our host cannot reach the CDN (no
    // interceptor under disableNetConnect -> the hop fails). Discord CAN reach
    // it, and the redirect target is sufficient proof of video, so we still
    // post the proxy URL instead of falling through to a weaker host.
    nock('https://fxtwitter.com')
      .get(PATH)
      .reply(302, '', { Location: 'https://unreachable-cdn.example.com/v/20.mp4' });
    // Intentionally no interceptor for unreachable-cdn.example.com.
    expect(await build()).toBe(fxUrl);
  });
});

// ---------------------------------------------------------------------------
// Facebook share-link expansion + OpenGraph card fallback, at the wire
// ---------------------------------------------------------------------------

describe('facebook share-link resolution contract', () => {
  const SHARE_PATH = '/share/r/1AcYfs5CNq/';
  const SHARE = new URL(`https://www.facebook.com${SHARE_PATH}`);
  const CANON_PATH = '/61585725097605/videos/866774919797953/';
  const CANON = `https://www.facebook.com${CANON_PATH}`;
  const PROXY_CANON = `https://facebed.com${CANON_PATH}`;

  const buildFb = async (url: URL): Promise<LinkPreviewResult | null> => {
    const provider = createFacebookProvider({
      proxyHosts: ['facebed.com'],
      ogClient: new OgClient(),
    });
    const result = await provider.build(url, { timeoutMs: 4000 });
    if (!isOk(result)) throw new Error('expected ok');
    return result.value;
  };

  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('chases the browser-UA redirect to the canonical, then proxies it for a playable video', async () => {
    // Facebook only redirects a share link to its canonical permalink for a
    // NON-crawler UA; the cookieless destination page body is irrelevant.
    nock('https://www.facebook.com', { reqheaders: { 'user-agent': /Chrome\// } })
      .get(SHARE_PATH)
      .reply(302, '', { Location: CANON });
    nock('https://www.facebook.com', { reqheaders: { 'user-agent': /Chrome\// } })
      .get(CANON_PATH)
      .reply(200, '<html><head><title>error</title></head><body>x</body></html>');
    // The Discord-crawler-UA proxy probe of the canonical yields og:video.
    nock('https://facebed.com', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(CANON_PATH)
      .reply(200, ogHtml(VIDEO_HEAD));

    expect(await buildFb(SHARE)).toEqual({
      kind: 'card',
      card: {
        url: CANON,
        title: undefined,
        description: undefined,
        imageUrl: undefined,
        siteName: 'Facebook',
      },
      media: { url: 'https://cdn.example/v.mp4', fallbackUrl: PROXY_CANON },
      sourceUrl: SHARE.href,
    });
  });

  it('falls back to a Facebook OpenGraph card when resolution fails and the proxy is a login wall', async () => {
    // No interceptor for the browser-UA resolution -> it errors (host
    // unreachable under disableNetConnect), so the original /share/ link is
    // probed; the proxy serves a login wall (junk), and we build a card from
    // Facebook's own OpenGraph (served to the Discord crawler UA).
    nock('https://facebed.com', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(SHARE_PATH)
      .reply(200, ogHtml('<meta property="og:title" content="Log in or sign up to view">'));
    nock('https://www.facebook.com', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(SHARE_PATH)
      .reply(
        200,
        ogHtml(
          [
            '<meta property="og:title" content="Lil mouse">',
            '<meta property="og:image" content="https://scontent.example/thumb.jpg">',
            '<meta property="og:url" content="https://www.facebook.com/p/1/">',
          ].join(''),
        ),
      );

    expect(await buildFb(SHARE)).toEqual({
      kind: 'card',
      card: {
        url: 'https://www.facebook.com/p/1/',
        title: 'Lil mouse',
        description: undefined,
        imageUrl: 'https://scontent.example/thumb.jpg',
        siteName: 'Facebook',
      },
      sourceUrl: SHARE.href,
    });
  });
  it('retains proxy engagement metadata in the Facebook card at the HTTP boundary', async () => {
    const path = '/example/posts/1';
    const source = `https://www.facebook.com${path}`;
    nock('https://facebed.com')
      .get(path)
      .reply(
        200,
        ogHtml(
          [
            '<meta property="og:title" content="Example Author">',
            '<meta property="og:description" content="Example post">',
            '<meta property="og:image" content="https://cdn.example/post.jpg">',
            '<meta property="og:site_name" content="facebed by pi.kt&#10;👍 🤗 708 • 💬 10 • 🔁 5">',
          ].join(''),
        ),
      );
    expect(await buildFb(new URL(source))).toEqual({
      kind: 'card',
      card: {
        url: source,
        title: 'Example Author',
        description: 'Example post',
        imageUrl: 'https://cdn.example/post.jpg',
        siteName: 'Facebook',
        engagement: { likes: 708, comments: 10, shares: 5 },
      },
      sourceUrl: source,
    });
  });
});

// ---------------------------------------------------------------------------
// Bilibili b23.tv short-link resolution, at the wire
// ---------------------------------------------------------------------------

describe('bilibili b23.tv resolution contract', () => {
  const B23_PATH = '/mHCI3y3';
  const B23 = new URL(`https://b23.tv${B23_PATH}`);
  const VIDEO_PATH = '/video/BV1xx411c7mD';
  const CANON = `https://www.bilibili.com${VIDEO_PATH}`;
  const PROXY = `https://vxbilibili.com${VIDEO_PATH}`;

  const buildB23 = async (url: URL): Promise<LinkPreviewResult | null> => {
    const provider = createBilibiliProvider({
      proxyHosts: ['vxbilibili.com'],
      ogClient: new OgClient(),
    });
    const result = await provider.build(url, { timeoutMs: 4000 });
    if (!isOk(result)) throw new Error('expected ok');
    return result.value;
  };

  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('chases the browser-UA redirect to the canonical video, then proxies it for a playable video', async () => {
    // b23.tv 302s a browser-like UA to the canonical /video/<BV> URL; the
    // cookieless destination page body is read only to be discarded.
    nock('https://b23.tv', { reqheaders: { 'user-agent': /Chrome\// } })
      .get(B23_PATH)
      .reply(302, '', { Location: CANON });
    nock('https://www.bilibili.com', { reqheaders: { 'user-agent': /Chrome\// } })
      .get(VIDEO_PATH)
      .reply(200, '<html><head><title>x</title></head><body>x</body></html>');
    // The Discord-crawler-UA proxy probe of the canonical yields og:video.
    nock('https://vxbilibili.com', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(VIDEO_PATH)
      .reply(200, ogHtml(VIDEO_HEAD));

    expect(await buildB23(B23)).toEqual({
      kind: 'rewritten-url',
      url: PROXY,
      sourceUrl: B23.href, // original short link carried, not the canonical
    });
  });

  it('posts nothing when the b23.tv link resolves to a non-video page (no proxy probe)', async () => {
    // Resolves to a live page (not `/video/<BV|av>`), so the video predicate
    // rejects it and no proxy host is probed — only the resolution hops run.
    nock('https://b23.tv', { reqheaders: { 'user-agent': /Chrome\// } })
      .get(B23_PATH)
      .reply(302, '', { Location: 'https://live.bilibili.com/123' });
    nock('https://live.bilibili.com', { reqheaders: { 'user-agent': /Chrome\// } })
      .get('/123')
      .reply(200, '<html><head><title>live</title></head><body>x</body></html>');

    expect(await buildB23(B23)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Threads share-link resolution — minimal UA + hop scanning, at the wire
// ---------------------------------------------------------------------------

describe('threads share-link resolution contract', () => {
  const SHARE_PATH = '/share/BAc3zqH7qQ/';
  const SHARE = new URL(`https://www.threads.com${SHARE_PATH}`);
  const LEGACY_SHARE = new URL(`https://www.threads.net${SHARE_PATH}`);
  const POST_PATH = '/@ajit86403/post/Dcp0Ly0iOIq';
  const PERMALINK = `https://www.threads.com${POST_PATH}`;
  const PROXY_PERMALINK = `https://vxthreads.net${POST_PATH}`;
  /** Single-use share attribution Threads mints into the first hop's target. */
  const SHARE_QUERY = { xmt: 'AQG0S6Tr0-abc', slof: '1' };
  const SHARE_SEARCH = `?xmt=${SHARE_QUERY.xmt}&slof=${SHARE_QUERY.slof}`;
  /** Where replaying the spent `xmt` token lands the chase. */
  const BOUNCE_QUERY = { error: 'invalid_post' };
  const BOUNCE = 'https://www.threads.com/?error=invalid_post';

  /**
   * Threads answers a full desktop-browser UA (the Chrome string
   * `resolveCanonical` sends) with a client-side-routed app shell — 200, no
   * `Location` — so a server-side chase observes no redirect at all. Only this
   * minimal UA gets the 30x chain. Matched exactly: the Chrome string extends
   * this one, so a prefix match would not tell the two apart.
   */
  const MINIMAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const chase = (origin: string): ReturnType<typeof nock> =>
    nock(origin, { reqheaders: { 'user-agent': MINIMAL_UA } });

  const buildThreads = async (url: URL): Promise<LinkPreviewResult | null> => {
    const provider = createThreadsProvider({
      proxyHosts: ['vxthreads.net'],
      ogClient: new OgClient(),
    });
    const result = await provider.build(url, { timeoutMs: 4000 });
    if (!isOk(result)) throw new Error('expected ok');
    return result.value;
  };

  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('chases the minimal-UA redirect chain, picks the permalink hop, then proxies it for a playable video', async () => {
    chase('https://www.threads.com')
      .get(SHARE_PATH)
      .reply(302, '', { Location: `${PERMALINK}${SHARE_SEARCH}` });
    // The `xmt` token is spent by the hop that carried it, so Threads bounces
    // the chase onward: the permalink exists only as an INTERMEDIATE hop and
    // the chain lands on the error page.
    chase('https://www.threads.com')
      .get(POST_PATH)
      .query(SHARE_QUERY)
      .reply(302, '', { Location: BOUNCE });
    chase('https://www.threads.com')
      .get('/')
      .query(BOUNCE_QUERY)
      .reply(200, ogHtml('<title>Threads</title>'));
    // The Discord-crawler-UA probe must hit the bare permalink path — no share
    // attribution reaches the proxy, and the landing URL is never probed.
    nock('https://vxthreads.net', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(POST_PATH)
      .reply(200, ogHtml(VIDEO_HEAD));

    expect(await buildThreads(SHARE)).toEqual({
      kind: 'rewritten-url',
      url: PROXY_PERMALINK,
      sourceUrl: SHARE.href, // original share link carried, not the permalink
    });
  });

  it('posts nothing when the chase never passes through a post permalink (no proxy probe)', async () => {
    chase('https://www.threads.com').get(SHARE_PATH).reply(302, '', { Location: BOUNCE });
    chase('https://www.threads.com')
      .get('/')
      .query(BOUNCE_QUERY)
      .reply(200, ogHtml('<title>Threads</title>'));
    // No proxy interceptor: with no permalink hop there is nothing previewable,
    // so the provider skips silently rather than probing the `/share/` token or
    // the error page. The leftover check still proves both chase hops ran.

    expect(await buildThreads(SHARE)).toBeNull();
  });

  it('absorbs the legacy threads.net 301 before the permalink hop', async () => {
    // threads.net redirects onto threads.com before the expansion, so the
    // permalink is the SECOND hop and the chain uses all three of the
    // SAFE_MAX_REDIRECTS budget.
    chase('https://www.threads.net').get(SHARE_PATH).reply(301, '', { Location: SHARE.href });
    chase('https://www.threads.com')
      .get(SHARE_PATH)
      .reply(302, '', { Location: `${PERMALINK}${SHARE_SEARCH}` });
    chase('https://www.threads.com')
      .get(POST_PATH)
      .query(SHARE_QUERY)
      .reply(302, '', { Location: BOUNCE });
    chase('https://www.threads.com')
      .get('/')
      .query(BOUNCE_QUERY)
      .reply(200, ogHtml('<title>Threads</title>'));
    nock('https://vxthreads.net', { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } })
      .get(POST_PATH)
      .reply(200, ogHtml(IMAGE_HEAD));

    expect(await buildThreads(LEGACY_SHARE)).toEqual({
      kind: 'rewritten-url',
      url: PROXY_PERMALINK,
      sourceUrl: LEGACY_SHARE.href,
    });
  });
});

// ---------------------------------------------------------------------------
// Threads host selection — the weak-image tier, at the wire
// ---------------------------------------------------------------------------

describe('threads weak-image host selection contract', () => {
  // Priority-ordered as the operator configures them: the proxy that resolves
  // the real post asset first, then the two video-capable ones. A plain
  // permalink is used so no share-link redirect chase is involved and the
  // probe sequence is exactly one request per host.
  const HOSTS = ['viewthreads.com', 'fzthreads.com', 'fixthreads.seria.moe'];
  const POST_PATH = '/@ajit86403/post/Dcp0Ly0iOIq';
  const PERMALINK = new URL(`https://www.threads.com${POST_PATH}`);
  const proxyUrl = (host: string): string => `https://${host}${POST_PATH}`;

  /** An fbcdn rendition path that carries the post's own media. */
  const POST_IMAGE = 'https://scontent.cdninstagram.com/v/t39.92108-6/501_n.jpg';
  /** The author's profile avatar — what a proxy serves when it has no post media. */
  const AVATAR_IMAGE = 'https://scontent.cdninstagram.com/v/t51.2885-19/338_n.jpg';
  /** A second avatar rendition, identified by its size segment instead. */
  const AVATAR_THUMB = 'https://scontent.cdninstagram.com/v/t51.12442-19/s150x150/338_n.jpg';

  const cardHead = (...images: readonly string[]): string =>
    [
      '<meta property="og:title" content="ajit86403 on Threads">',
      ...images.map((image) => `<meta property="og:image" content="${image}">`),
    ].join('');

  const crawler = (host: string): ReturnType<typeof nock> =>
    nock(`https://${host}`, { reqheaders: { 'user-agent': /Discordbot\/2\.0/ } });

  /** Stub one proxy host answering the permalink probe with an OpenGraph head. */
  const serves = (host: string, head: string): void => {
    crawler(host).get(POST_PATH).reply(200, ogHtml(head));
  };

  /** Stub one proxy host as degraded, so the loop must fall through it. */
  const isDown = (host: string): void => {
    crawler(host).get(POST_PATH).reply(503, 'down');
  };

  const buildThreads = async (): Promise<string | null> => {
    const provider = createThreadsProvider({ proxyHosts: HOSTS, ogClient: new OgClient() });
    const result = await provider.build(PERMALINK, { timeoutMs: 4000 });
    if (!isOk(result)) throw new Error('expected ok');
    if (result.value === null) return null;
    if (result.value.kind !== 'rewritten-url') throw new Error('expected rewritten-url');
    return result.value.url;
  };

  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('prefers the host serving the real post image over one serving only the avatar', async () => {
    // All three hosts are probed: neither image tier short-circuits, because a
    // later host may still hold the video. The avatar-only candidate is the
    // one the weak-image tier exists to demote.
    serves('viewthreads.com', cardHead(POST_IMAGE));
    serves('fzthreads.com', cardHead(AVATAR_IMAGE));
    serves('fixthreads.seria.moe', cardHead(AVATAR_THUMB));

    expect(await buildThreads()).toBe(proxyUrl('viewthreads.com'));
  });

  it('posts an avatar-only host when it is the only one that responds', async () => {
    // A weak image still beats posting nothing: the alternative is silence on
    // a post that does have a readable title and author.
    isDown('viewthreads.com');
    serves('fzthreads.com', cardHead(AVATAR_IMAGE));
    isDown('fixthreads.seria.moe');

    expect(await buildThreads()).toBe(proxyUrl('fzthreads.com'));
  });

  it('passes over an avatar-only first host for a later one holding the real asset', async () => {
    // Probe order alone would post the first host; only the tier separation
    // keeps the avatar behind a real post image found further down the list.
    serves('viewthreads.com', cardHead(AVATAR_IMAGE));
    serves('fzthreads.com', cardHead(POST_IMAGE));
    serves('fixthreads.seria.moe', cardHead(AVATAR_THUMB));

    expect(await buildThreads()).toBe(proxyUrl('fzthreads.com'));
  });

  it('promotes a later host whose images mix the avatar with the real asset', async () => {
    // One non-avatar image is enough: the candidate carries a real post asset,
    // so it scores as a plain image and outranks the earlier avatar-only host
    // despite being probed second.
    serves('viewthreads.com', cardHead(AVATAR_IMAGE));
    serves('fzthreads.com', cardHead(AVATAR_IMAGE, POST_IMAGE));
    isDown('fixthreads.seria.moe');

    expect(await buildThreads()).toBe(proxyUrl('fzthreads.com'));
  });

  it('lets a later host with og:video win over an earlier host that served an image', async () => {
    // Video short-circuits from any position, which is why listing the
    // real-asset proxy first costs a video post nothing. The third host is
    // never probed — a leftover interceptor would fail the afterEach check.
    serves('viewthreads.com', cardHead(POST_IMAGE));
    serves('fzthreads.com', VIDEO_HEAD);

    expect(await buildThreads()).toBe(proxyUrl('fzthreads.com'));
  });

  it('posts nothing when every host serves only the avatar behind a login wall', async () => {
    // The junk filter runs ahead of both image tiers, so a gated page scores
    // `none` however many images it carries — weak-image must not resurrect it.
    const gated = ['<meta property="og:title" content="Threads • Log in">', cardHead(AVATAR_IMAGE)];
    for (const host of HOSTS) serves(host, gated.join(''));

    expect(await buildThreads()).toBeNull();
  });
});
