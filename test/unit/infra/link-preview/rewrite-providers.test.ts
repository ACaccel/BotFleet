/**
 * Unit tests for the URL-rewrite providers (Twitter/X, Instagram, Threads,
 * Facebook, Reddit). `canHandle` is a pure host/path predicate; `build`
 * probes a priority list of proxy hosts via an injected {@link OgClient},
 * scoring video > image > weak-image > text-only and posting nothing when no
 * host yields media. A per-candidate-URL fake OgClient drives the loop
 * deterministically.
 *
 * Two providers expand short links before probing, each with its own fake
 * covering both the expansion call and the OG fetch: Facebook reads the
 * canonical landing URL (`resolveCanonical`), while Threads scans every hop
 * of the redirect chain (`resolveRedirectChain`) because its permalink is an
 * intermediate hop. The junk-marker suite pins the login-wall placeholders
 * that must never be posted as a card, image-bearing ones included.
 *
 * The weak-image tier is exercised twice: as a pure `scoreMeta` matrix, and
 * end-to-end through the Threads provider, whose proxies divide the work so
 * unevenly (one holds the real post asset, the others the video and the
 * gated posts) that the tier order decides which card a reader actually sees.
 *
 * The punt suite pins the case a real Instagram outage produced: a proxy
 * that 302s back to instagram.com, where the bot host reads a genuine image
 * card that Discord's own crawler never gets to see.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createTwitterProvider,
  createInstagramProvider,
  createThreadsProvider,
  createFacebookProvider,
  createRedditProvider,
  invalidResponseError,
} from '../../../../src/infra/link-preview';
import {
  scoreMeta,
  isJunkPreviewTitle,
  landsOnSource,
} from '../../../../src/infra/link-preview/providers/rewrite-provider';
import { ok, err, isOk, type Result } from '../../../../src/core/result';
import type {
  LinkPreviewProvider,
  LinkPreviewBuildContext,
  LinkPreviewFailure,
  LinkPreviewResult,
  OgClient,
  OpenGraphMeta,
} from '../../../../src/infra/link-preview';
import type { Logger } from '../../../../src/core/logger';

const u = (href: string): URL => new URL(href);

/** Build an OpenGraphMeta with sensible empties. */
const meta = (m: Partial<OpenGraphMeta> = {}): OpenGraphMeta => ({ images: [], ...m });

type MetaResult = Result<OpenGraphMeta, LinkPreviewFailure>;

/** Fake OgClient keyed by the EXACT candidate URL the provider builds. */
const makeOgClient = (
  byUrl: Readonly<Record<string, MetaResult>>,
): { client: OgClient; fetch: ReturnType<typeof vi.fn> } => {
  const fetch = vi.fn(
    async (url: string): Promise<MetaResult> => byUrl[url] ?? ok(meta()), // unknown URL = empty (no media)
  );
  return { client: { fetch } as unknown as OgClient, fetch };
};

const makeLogger = (): Logger => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger;
};

const emptyClient = (): OgClient => makeOgClient({}).client;

/** Run build and return the chosen rewritten URL, or null. */
const buildUrl = async (
  provider: LinkPreviewProvider,
  href: string,
  ctx: LinkPreviewBuildContext = { timeoutMs: 1000 },
): Promise<string | null> => {
  const result = await provider.build(u(href), ctx);
  if (!isOk(result)) throw new Error(`expected ok for ${href}`);
  if (result.value === null) return null;
  if (result.value.kind !== 'rewritten-url') throw new Error('expected rewritten-url');
  return result.value.url;
};

// ---------------------------------------------------------------------------
// canHandle matrices (pure — no network)
// ---------------------------------------------------------------------------

describe('twitter provider canHandle', () => {
  const provider = createTwitterProvider({
    proxyHosts: ['fxtwitter.com'],
    ogClient: emptyClient(),
  });

  it('matches tweet URLs on twitter.com and x.com (incl. www/mobile)', () => {
    expect(provider.canHandle(u('https://twitter.com/jack/status/20'))).toBe(true);
    expect(provider.canHandle(u('https://x.com/jack/status/20'))).toBe(true);
    expect(provider.canHandle(u('https://mobile.twitter.com/jack/status/20'))).toBe(true);
    expect(provider.canHandle(u('https://www.x.com/jack/status/20'))).toBe(true);
  });

  it('rejects profiles, search, and already-proxied hosts', () => {
    expect(provider.canHandle(u('https://x.com/jack'))).toBe(false);
    expect(provider.canHandle(u('https://x.com/search?q=cats'))).toBe(false);
    expect(provider.canHandle(u('https://fxtwitter.com/jack/status/20'))).toBe(false);
  });

  it('rejects look-alike hosts', () => {
    expect(provider.canHandle(u('https://nottwitter.com/jack/status/20'))).toBe(false);
    expect(provider.canHandle(u('https://x.com.evil.com/jack/status/20'))).toBe(false);
  });
});

describe('instagram provider canHandle', () => {
  const provider = createInstagramProvider({
    proxyHosts: ['kkinstagram.com'],
    ogClient: emptyClient(),
  });

  it('matches post / reel / tv URLs', () => {
    expect(provider.canHandle(u('https://www.instagram.com/p/Cabc123/'))).toBe(true);
    expect(provider.canHandle(u('https://instagram.com/reel/Cxyz/'))).toBe(true);
    expect(provider.canHandle(u('https://www.instagram.com/tv/Cqqq/'))).toBe(true);
  });

  it('matches author-prefixed post / reel URLs (profile / share-link form)', () => {
    expect(provider.canHandle(u('https://www.instagram.com/nasa/reel/CvNoLm8Ouaa/'))).toBe(true);
    expect(provider.canHandle(u('https://www.instagram.com/nasa/p/Cabc123/'))).toBe(true);
    expect(provider.canHandle(u('https://instagram.com/some.user/tv/Cqqq/'))).toBe(true);
  });

  it('rejects profile URLs', () => {
    expect(provider.canHandle(u('https://www.instagram.com/someuser/'))).toBe(false);
  });
});

describe('threads provider canHandle', () => {
  const provider = createThreadsProvider({
    proxyHosts: ['vxthreads.net'],
    ogClient: emptyClient(),
  });

  it('matches post URLs on threads.net and threads.com', () => {
    expect(provider.canHandle(u('https://www.threads.net/@user/post/Cabc'))).toBe(true);
    expect(provider.canHandle(u('https://threads.com/@user/post/Cabc'))).toBe(true);
    expect(provider.canHandle(u('https://www.threads.net/t/Cabc'))).toBe(true);
  });

  it('matches /share/<token> short links on both hosts (incl. www)', () => {
    expect(provider.canHandle(u('https://threads.com/share/BAc3zqH7qQ/'))).toBe(true);
    expect(provider.canHandle(u('https://threads.net/share/BAc3zqH7qQ'))).toBe(true);
    expect(provider.canHandle(u('https://www.threads.com/share/BAc3zqH7qQ/'))).toBe(true);
  });

  it('rejects profile URLs and a token-less /share/ path', () => {
    expect(provider.canHandle(u('https://www.threads.net/@user'))).toBe(false);
    expect(provider.canHandle(u('https://www.threads.com/share/'))).toBe(false);
  });

  // The host allow-list is the precondition `OgClient.resolveRedirectChain`
  // documents: a share link is chased before any proxy sees it, so an
  // unconstrained host would let a posted link aim that chase at any origin.
  it('rejects look-alike hosts for both the post and share forms', () => {
    expect(provider.canHandle(u('https://notthreads.com/share/BAc3zqH7qQ/'))).toBe(false);
    expect(provider.canHandle(u('https://threads.com.evil.com/share/BAc3zqH7qQ/'))).toBe(false);
    expect(provider.canHandle(u('https://evil.com/@user/post/Cabc'))).toBe(false);
  });
});

describe('facebook provider canHandle', () => {
  const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: emptyClient() });

  it('matches posts, videos, reels, watch, share, and fb.watch', () => {
    expect(provider.canHandle(u('https://www.facebook.com/page/posts/123'))).toBe(true);
    expect(provider.canHandle(u('https://www.facebook.com/page/videos/123'))).toBe(true);
    expect(provider.canHandle(u('https://www.facebook.com/reel/123'))).toBe(true);
    expect(provider.canHandle(u('https://www.facebook.com/watch/?v=123'))).toBe(true);
    expect(provider.canHandle(u('https://www.facebook.com/share/r/1AcYfs5CNq/'))).toBe(true);
    expect(provider.canHandle(u('https://fb.watch/abc123/'))).toBe(true);
  });

  it('rejects bare profile URLs', () => {
    expect(provider.canHandle(u('https://www.facebook.com/someuser'))).toBe(false);
  });
});

describe('reddit provider canHandle', () => {
  const provider = createRedditProvider({ proxyHosts: ['vxreddit.com'], ogClient: emptyClient() });

  it('matches comment permalinks and share links across reddit host variants', () => {
    expect(provider.canHandle(u('https://www.reddit.com/r/funny/comments/g0xb6c/title/'))).toBe(
      true,
    );
    expect(provider.canHandle(u('https://reddit.com/r/aww/comments/abc123/'))).toBe(true);
    expect(provider.canHandle(u('https://old.reddit.com/r/pics/comments/haucpf/slug/'))).toBe(true);
    expect(provider.canHandle(u('https://np.reddit.com/comments/abc123'))).toBe(true); // bare /comments/
    expect(provider.canHandle(u('https://www.reddit.com/r/videos/s/aB9xYz0Q'))).toBe(true); // share link
  });

  it('rejects bare subreddit, user, and home URLs', () => {
    expect(provider.canHandle(u('https://www.reddit.com/r/funny/'))).toBe(false);
    expect(provider.canHandle(u('https://www.reddit.com/user/spez/'))).toBe(false);
    expect(provider.canHandle(u('https://www.reddit.com/'))).toBe(false);
    // already-proxied hosts are not matched
    expect(provider.canHandle(u('https://vxreddit.com/r/funny/comments/g0xb6c/title/'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Validation loop (the shared rewrite-provider logic, exercised via twitter)
// ---------------------------------------------------------------------------

describe('rewrite-provider validation loop', () => {
  const HOSTS = ['fxtwitter.com', 'vxtwitter.com'];
  const fx = 'https://fxtwitter.com/jack/status/20';
  const vx = 'https://vxtwitter.com/jack/status/20';
  const tweet = 'https://x.com/jack/status/20';

  it('short-circuits on the first host that yields a video (no debug log on the clean path)', async () => {
    const { client, fetch } = makeOgClient({ [fx]: ok(meta({ video: 'v.mp4' })) });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    const logger = makeLogger();
    expect(await buildUrl(provider, tweet, { timeoutMs: 1000, logger })).toBe(fx);
    expect(fetch).toHaveBeenCalledTimes(1); // never probed vxtwitter
    expect(fetch).toHaveBeenCalledWith(fx, 'twitter', 1000);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('chooses the first text-only host when no host has image or video', async () => {
    const { client } = makeOgClient({
      [fx]: ok(meta({ title: 'a' })),
      [vx]: ok(meta({ title: 'b' })),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, tweet)).toBe(fx);
  });

  it('prefers a later video host over an earlier image-only host', async () => {
    const { client, fetch } = makeOgClient({
      [fx]: ok(meta({ images: ['i.jpg'] })),
      [vx]: ok(meta({ video: 'v.mp4' })),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, tweet)).toBe(vx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to the first image-bearing host when no host has video', async () => {
    const { client } = makeOgClient({
      [fx]: ok(meta({ images: ['a.jpg'] })),
      [vx]: ok(meta({ images: ['b.jpg'] })),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, tweet)).toBe(fx);
  });

  it('uses a text-only host only when no host has image or video', async () => {
    const { client } = makeOgClient({
      [fx]: ok(meta({ title: 'just text' })),
      [vx]: ok(meta({ images: ['b.jpg'] })),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    // image beats text even though the text host came first
    expect(await buildUrl(provider, tweet)).toBe(vx);
  });

  it('returns null (skip, no bare link) when no host yields anything usable', async () => {
    const { client } = makeOgClient({
      [fx]: ok(meta()),
      [vx]: err(invalidResponseError('twitter')),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, tweet)).toBeNull();
  });

  it('logs a failed host probe at debug and continues to the next', async () => {
    const { client, fetch } = makeOgClient({
      [fx]: err(invalidResponseError('twitter')),
      [vx]: ok(meta({ video: 'v.mp4' })),
    });
    const provider = createTwitterProvider({ proxyHosts: HOSTS, ogClient: client });
    const logger = makeLogger();
    expect(await buildUrl(provider, tweet, { timeoutMs: 1000, logger })).toBe(vx);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('walks past every failed host until one succeeds, however far down the list', async () => {
    const hosts = ['a.example', 'b.example', 'c.example'];
    const at = (host: string): string => `https://${host}/jack/status/20`;
    const { client, fetch } = makeOgClient({
      [at('a.example')]: err(invalidResponseError('twitter')),
      [at('b.example')]: err(invalidResponseError('twitter')),
      [at('c.example')]: ok(meta({ images: ['c.jpg'] })),
    });
    const provider = createTwitterProvider({ proxyHosts: hosts, ogClient: client });
    expect(await buildUrl(provider, 'https://x.com/jack/status/20')).toBe(at('c.example'));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('probes the whole list before giving up when every host fails', async () => {
    const hosts = ['a.example', 'b.example', 'c.example'];
    const at = (host: string): string => `https://${host}/jack/status/20`;
    const { client, fetch } = makeOgClient({
      [at('a.example')]: err(invalidResponseError('twitter')),
      [at('b.example')]: err(invalidResponseError('twitter')),
      [at('c.example')]: err(invalidResponseError('twitter')),
    });
    const provider = createTwitterProvider({ proxyHosts: hosts, ogClient: client });
    expect(await buildUrl(provider, 'https://x.com/jack/status/20')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Login-wall / junk-OG rejection (scoreMeta + end-to-end)
// ---------------------------------------------------------------------------

describe('scoreMeta login-wall / junk rejection', () => {
  it('flags known login-wall / not-found placeholder titles', () => {
    expect(isJunkPreviewTitle('Log in or sign up to view')).toBe(true);
    expect(isJunkPreviewTitle('See posts, photos and more on Facebook.')).toBe(true);
    expect(isJunkPreviewTitle('a perfectly normal tweet')).toBe(false);
  });

  it('scores a login-wall placeholder as none (never a usable text card)', () => {
    expect(scoreMeta(meta({ title: 'Log in or sign up to view' }))).toBe('none');
    // even when the wall serves a generic logo image
    expect(scoreMeta(meta({ title: 'Log in or sign up to view', images: ['logo.png'] }))).toBe(
      'none',
    );
  });

  it('rejects an Instagram proxy that answers "Post not found" under its product title', () => {
    // eeinstagram cannot resolve a post: `og:title` is the product name and
    // the description says "Post not found" — a text card with no content.
    expect(scoreMeta(meta({ title: 'fix instagram embeds', description: 'Post not found' }))).toBe(
      'none',
    );
  });

  it('rejects a vxReddit proxy-error page (title is the proxy name / description says failed)', () => {
    expect(isJunkPreviewTitle('vxReddit')).toBe(true);
    // vxReddit's error page: og:title="vxReddit", og:description="Failed to get data from Reddit"
    expect(
      scoreMeta(meta({ title: 'vxReddit', description: 'Failed to get data from Reddit' })),
    ).toBe('none');
    // description marker alone is enough even if the title were generic
    expect(
      scoreMeta(meta({ title: 'reddit', description: 'Failed to get data from Reddit' })),
    ).toBe('none');
  });

  it('flags the Threads login-wall titles', () => {
    expect(isJunkPreviewTitle('Threads • 登入')).toBe(true);
    expect(isJunkPreviewTitle('Threads • Log in')).toBe(true);
    // The per-account variant names no product state, so the title alone is
    // indistinguishable from a real post; the description marker catches it.
    expect(isJunkPreviewTitle('• 登入 (@ajit86403) on Threads')).toBe(false);
  });

  it('rejects the Threads login-wall description in both catalog languages', () => {
    expect(
      scoreMeta(
        meta({
          title: '• 登入 (@ajit86403) on Threads',
          description:
            '加入 Threads 即可分享意見、詢問問題、隨興發佈想法、尋找志趣相投的同好等等。使用你的 Instagram 登入。',
        }),
      ),
    ).toBe('none');
    expect(
      scoreMeta(
        meta({
          title: '• 登入 (@ajit86403) on Threads',
          description:
            'Join Threads to share ideas, ask questions, post random thoughts, find your people and more. Log in with your Instagram.',
        }),
      ),
    ).toBe('none');
  });

  it('scores a Threads login wall with a generic logo image as none, not image', () => {
    const logo = 'https://static.cdninstagram.com/rsrc.php/instagram-logo.png';
    // The wall always ships that logo as og:image, so the image tier alone
    // would have graded these usable and posted a "Log in" card.
    expect(scoreMeta(meta({ title: 'Threads • 登入', images: [logo] }))).toBe('none');
    expect(scoreMeta(meta({ title: 'Threads • Log in', images: [logo] }))).toBe('none');
    expect(
      scoreMeta(
        meta({
          title: '• 登入 (@ajit86403) on Threads',
          description:
            '加入 Threads 即可分享意見、詢問問題、隨興發佈想法、尋找志趣相投的同好等等。使用你的 Instagram 登入。',
          images: [logo],
        }),
      ),
    ).toBe('none');
  });

  it('still scores real media / text above the junk filter', () => {
    expect(scoreMeta(meta({ title: 'Log in or sign up to view', video: 'v.mp4' }))).toBe('video');
    expect(scoreMeta(meta({ title: 'just a normal post' }))).toBe('text');
    expect(scoreMeta(meta({ images: ['i.jpg'] }))).toBe('image');
  });

  it('returns null (no broken card) when every proxy yields only a login wall', async () => {
    const fx = 'https://fxtwitter.com/jack/status/20';
    const vx = 'https://vxtwitter.com/jack/status/20';
    const { client } = makeOgClient({
      [fx]: ok(meta({ title: 'Log in or sign up to view' })),
      [vx]: ok(meta({ title: 'Log in or sign up to view' })),
    });
    const provider = createTwitterProvider({
      proxyHosts: ['fxtwitter.com', 'vxtwitter.com'],
      ogClient: client,
    });
    expect(await buildUrl(provider, 'https://x.com/jack/status/20')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Weak-image tier (scoreMeta with low-value image patterns)
// ---------------------------------------------------------------------------

/** fbcdn / cdninstagram avatar renditions, as the Threads provider matches them. */
const AVATAR_PATTERNS: readonly RegExp[] = [/\/t51\.2885-19\//, /\/s150x150\//];

/** A profile avatar a proxy substitutes when it cannot resolve the post's media. */
const AVATAR_IMAGE =
  'https://scontent.cdninstagram.com/v/t51.2885-19/489233911_1_n.jpg?_nc_cat=104';
/** The other avatar rendition shape, served at thumbnail size. */
const AVATAR_THUMB = 'https://scontent-tpe1-1.cdninstagram.com/v/s150x150/489233911_2_n.jpg';
/** Media belonging to the post itself. */
const POST_IMAGE = 'https://scontent-tpe1-1.cdninstagram.com/v/t39.92108-6/512004411_3_n.jpg';

describe('scoreMeta weak-image tier', () => {
  it('scores an all-avatar image set as weak-image', () => {
    expect(scoreMeta(meta({ images: [AVATAR_IMAGE] }), AVATAR_PATTERNS)).toBe('weak-image');
    expect(scoreMeta(meta({ images: [AVATAR_IMAGE, AVATAR_THUMB] }), AVATAR_PATTERNS)).toBe(
      'weak-image',
    );
  });

  it('scores a mixed set as image (one real post asset is enough)', () => {
    expect(scoreMeta(meta({ images: [AVATAR_IMAGE, POST_IMAGE] }), AVATAR_PATTERNS)).toBe('image');
    expect(scoreMeta(meta({ images: [POST_IMAGE, AVATAR_THUMB] }), AVATAR_PATTERNS)).toBe('image');
  });

  it('takes every image at face value when no patterns are supplied', () => {
    // Backwards compatibility: a source that opts out of the tier is scored
    // exactly as before, avatar renditions included.
    expect(scoreMeta(meta({ images: [AVATAR_IMAGE] }))).toBe('image');
    expect(scoreMeta(meta({ images: [AVATAR_IMAGE] }), [])).toBe('image');
  });

  it('still lets a video outrank an avatar-only image set', () => {
    expect(
      scoreMeta(meta({ video: 'https://v.example/clip.mp4', images: [AVATAR_IMAGE] }), [
        ...AVATAR_PATTERNS,
      ]),
    ).toBe('video');
  });

  it('keeps the junk filter ahead of the weak-image tier', () => {
    // A login wall whose only image is an avatar is still nothing to post.
    expect(
      scoreMeta(
        meta({ title: 'Threads • 登入', images: [AVATAR_IMAGE, AVATAR_THUMB] }),
        AVATAR_PATTERNS,
      ),
    ).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Weak-image selection precedence in the probe loop (via the threads provider)
// ---------------------------------------------------------------------------

describe('probe-loop precedence around the weak-image tier', () => {
  const permalink = 'https://www.threads.com/@user/post/Dcp0Ly0iOIq';
  const path = '/@user/post/Dcp0Ly0iOIq';
  const at = (host: string): string => `https://${host}${path}`;

  const providerWith = (
    hosts: readonly string[],
    byUrl: Readonly<Record<string, MetaResult>>,
  ): { provider: LinkPreviewProvider; fetch: ReturnType<typeof vi.fn> } => {
    const { client, fetch } = makeOgClient(byUrl);
    return { provider: createThreadsProvider({ proxyHosts: hosts, ogClient: client }), fetch };
  };

  it('prefers a real post image over a weak image probed FIRST', async () => {
    const { provider, fetch } = providerWith(['fzthreads.com', 'viewthreads.com'], {
      [at('fzthreads.com')]: ok(meta({ title: 'a post', images: [AVATAR_IMAGE] })),
      [at('viewthreads.com')]: ok(meta({ title: 'a post', images: [POST_IMAGE] })),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('viewthreads.com'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('prefers a weak image over a text-only host probed FIRST', async () => {
    const { provider } = providerWith(['viewthreads.com', 'fzthreads.com'], {
      [at('viewthreads.com')]: ok(meta({ title: 'a post' })),
      [at('fzthreads.com')]: ok(meta({ title: 'a post', images: [AVATAR_THUMB] })),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fzthreads.com'));
  });

  it('posts a weak image rather than nothing', async () => {
    const { provider } = providerWith(['viewthreads.com', 'fzthreads.com'], {
      [at('viewthreads.com')]: ok(meta()),
      [at('fzthreads.com')]: ok(meta({ images: [AVATAR_IMAGE] })),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fzthreads.com'));
  });

  it('does not short-circuit on a weak image — a later video host still wins', async () => {
    const { provider, fetch } = providerWith(['fzthreads.com', 'fixthreads.seria.moe'], {
      [at('fzthreads.com')]: ok(meta({ images: [AVATAR_IMAGE] })),
      [at('fixthreads.seria.moe')]: ok(meta({ video: 'https://v.example/clip.mp4' })),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fixthreads.seria.moe'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Threads host selection end-to-end, on the audited host ordering
// ---------------------------------------------------------------------------

describe('threads host selection per post type', () => {
  const THREADS_HOSTS = ['viewthreads.com', 'fzthreads.com', 'fixthreads.seria.moe'] as const;
  const permalink = 'https://www.threads.com/@ajit86403/post/Dcp0Ly0iOIq';
  const path = '/@ajit86403/post/Dcp0Ly0iOIq';
  const at = (host: string): string => `https://${host}${path}`;

  const providerWith = (
    byUrl: Readonly<Record<string, MetaResult>>,
  ): { provider: LinkPreviewProvider; fetch: ReturnType<typeof vi.fn> } => {
    const { client, fetch } = makeOgClient(byUrl);
    return {
      provider: createThreadsProvider({ proxyHosts: [...THREADS_HOSTS], ogClient: client }),
      fetch,
    };
  };

  it('picks the video host for a video post, past an earlier real-image host', async () => {
    // viewthreads renders the video as a still thumbnail and never og:video,
    // so the playable card only exists further down the list.
    const { provider, fetch } = providerWith({
      [at('viewthreads.com')]: ok(
        meta({
          title: 'ajit86403 (@ajit86403) on Threads',
          description: '下班路上拍到的夕陽',
          images: [POST_IMAGE],
        }),
      ),
      [at('fzthreads.com')]: ok(
        meta({
          title: 'ajit86403 (@ajit86403) on Threads',
          video: 'https://scontent-tpe1-1.cdninstagram.com/o1/v/t2/f2/m86/clip.mp4',
          images: [POST_IMAGE],
        }),
      ),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fzthreads.com'));
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([at('viewthreads.com'), at('fzthreads.com')]);
  });

  it('picks the real-image host for an ordinary post whose video hosts serve an avatar', async () => {
    const { provider, fetch } = providerWith({
      [at('viewthreads.com')]: ok(
        meta({
          title: 'ajit86403 (@ajit86403) on Threads',
          description: '今天的午餐',
          images: [POST_IMAGE],
        }),
      ),
      [at('fzthreads.com')]: ok(
        meta({
          title: 'ajit86403 (@ajit86403) on Threads',
          description: '今天的午餐',
          images: [AVATAR_IMAGE],
        }),
      ),
      [at('fixthreads.seria.moe')]: ok(
        meta({ title: 'ajit86403 on Threads', images: [AVATAR_THUMB] }),
      ),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('viewthreads.com'));
    // No video anywhere, so every host is probed before the choice is made.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('skips a Threads account-title placeholder when another host has the post image', async () => {
    const { provider } = providerWith({
      [at('viewthreads.com')]: ok(meta({ title: '@ajit86403 on Threads', description: '' })),
      [at('fzthreads.com')]: ok(
        meta({ title: '@ajit86403 (@ajit86403)', description: 'Post text', images: [POST_IMAGE] }),
      ),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fzthreads.com'));
  });

  it('skips an empty Threads account card when no host resolves the post', async () => {
    const { provider, fetch } = providerWith({
      [at('viewthreads.com')]: ok(meta({ title: '@ajit86403 on Threads', description: '' })),
    });
    expect(await buildUrl(provider, permalink)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps a text-only Threads post when its description contains content', async () => {
    const { provider } = providerWith({
      [at('viewthreads.com')]: ok(
        meta({ title: '@ajit86403 on Threads', description: 'Post text' }),
      ),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('viewthreads.com'));
  });

  it('skips a login wall in the image slot and picks the host that resolved the post', async () => {
    const loginWallLogo = 'https://static.cdninstagram.com/rsrc.php/instagram-logo.png';
    const { provider, fetch } = providerWith({
      // A login-restricted post: viewthreads answers with the zh-TW wall,
      // which carries an image and would otherwise claim the image slot and
      // lock out the only host that can actually read the post.
      [at('viewthreads.com')]: ok(
        meta({
          title: '• 登入 (@ajit86403) on Threads',
          description:
            '加入 Threads 即可分享意見、詢問問題、隨興發佈想法、尋找志趣相投的同好等等。使用你的 Instagram 登入。',
          images: [loginWallLogo],
        }),
      ),
      [at('fzthreads.com')]: ok(
        meta({
          title: 'ajit86403 (@ajit86403) on Threads',
          description: '只有追蹤者看得到的貼文',
          images: [POST_IMAGE],
        }),
      ),
    });
    expect(await buildUrl(provider, permalink)).toBe(at('fzthreads.com'));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Per-provider rewrite / query handling + host-list ordering
// ---------------------------------------------------------------------------

describe('rewrite URL construction', () => {
  it('twitter drops the query string', async () => {
    const url = 'https://fxtwitter.com/jack/status/20';
    const { client } = makeOgClient({ [url]: ok(meta({ video: 'v.mp4' })) });
    const provider = createTwitterProvider({ proxyHosts: ['fxtwitter.com'], ogClient: client });
    expect(await buildUrl(provider, 'https://x.com/jack/status/20?s=46')).toBe(url);
  });

  it('instagram drops the query string', async () => {
    const url = 'https://kkinstagram.com/reel/Cabc/';
    const { client } = makeOgClient({ [url]: ok(meta({ video: 'v.mp4' })) });
    const provider = createInstagramProvider({
      proxyHosts: ['kkinstagram.com'],
      ogClient: client,
    });
    expect(await buildUrl(provider, 'https://www.instagram.com/reel/Cabc/?igsh=xyz')).toBe(url);
  });

  it('facebook PRESERVES the query string (watch ids live there)', async () => {
    const url = 'https://facebed.com/watch/?v=123';
    const { client } = makeOgClient({ [url]: ok(meta({ video: 'v.mp4' })) });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await buildUrl(provider, 'https://www.facebook.com/watch/?v=123')).toBe(url);
  });

  it('threads probes its hosts in priority order until one yields media', async () => {
    const third = 'https://threadsez.com/@user/post/Cabc';
    const { client, fetch } = makeOgClient({ [third]: ok(meta({ video: 'v.mp4' })) });
    const provider = createThreadsProvider({
      proxyHosts: ['vxthreads.net', 'viewthreads.com', 'threadsez.com'],
      ogClient: client,
    });
    expect(await buildUrl(provider, 'https://www.threads.net/@user/post/Cabc')).toBe(third);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'https://vxthreads.net/@user/post/Cabc',
      'https://viewthreads.com/@user/post/Cabc',
      third,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Threads share-link resolution (hop scanning, not landing URL)
// ---------------------------------------------------------------------------

describe('threads share-link resolution', () => {
  const HOST = 'vxthreads.net';
  const share = 'https://www.threads.com/share/BAc3zqH7qQ/';
  const permalink = 'https://www.threads.com/@ajit86403/post/Dcp0Ly0iOIq';
  const proxyPermalink = 'https://vxthreads.net/@ajit86403/post/Dcp0Ly0iOIq';
  /** Threads serves the 30x chain only to a minimal UA; a desktop UA gets the SPA shell. */
  const MINIMAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

  type ChainResult = Result<readonly string[], LinkPreviewFailure>;

  /** Fake OgClient exposing BOTH the redirect chase and the OG fetch. */
  const makeThreadsClient = (opts: {
    chain?: Readonly<Record<string, ChainResult>>;
    fetchByUrl?: Readonly<Record<string, MetaResult>>;
  }): {
    client: OgClient;
    fetch: ReturnType<typeof vi.fn>;
    resolveRedirectChain: ReturnType<typeof vi.fn>;
  } => {
    const fetch = vi.fn(
      async (url: string): Promise<MetaResult> => opts.fetchByUrl?.[url] ?? ok(meta()),
    );
    const resolveRedirectChain = vi.fn(
      async (url: string): Promise<ChainResult> =>
        opts.chain?.[url] ?? err(invalidResponseError('threads')),
    );
    return {
      client: { fetch, resolveRedirectChain } as unknown as OgClient,
      fetch,
      resolveRedirectChain,
    };
  };

  const build = async (
    provider: LinkPreviewProvider,
    href: string,
  ): Promise<LinkPreviewResult | null> => {
    const result = await provider.build(u(href), { timeoutMs: 1000 });
    if (!isOk(result)) throw new Error(`expected ok for ${href}`);
    return result.value;
  };

  const providerWith = (client: OgClient): LinkPreviewProvider =>
    createThreadsProvider({ proxyHosts: [HOST], ogClient: client });

  it('expands a share link via the redirect chain, then probes the permalink', async () => {
    const { client, resolveRedirectChain, fetch } = makeThreadsClient({
      chain: { [share]: ok([permalink]) },
      fetchByUrl: { [proxyPermalink]: ok(meta({ video: 'v.mp4' })) },
    });
    expect(await build(providerWith(client), share)).toEqual({
      kind: 'rewritten-url',
      url: proxyPermalink,
      sourceUrl: share, // original share link is carried, not the resolved permalink
    });
    expect(resolveRedirectChain).toHaveBeenCalledWith(share, 1000, 'threads', MINIMAL_UA);
    expect(fetch).toHaveBeenCalledWith(proxyPermalink, 'threads', 1000);
    expect(fetch.mock.calls.every((c) => !String(c[0]).includes('/share/'))).toBe(true);
  });

  it('picks the permalink hop out of the real chain and ignores the invalid-post bounce', async () => {
    const { client, fetch } = makeThreadsClient({
      chain: {
        [share]: ok([
          `${permalink}?xmt=AQG0S6Tr0-abc&slof=1`,
          'https://www.threads.com/?error=invalid_post',
        ]),
      },
      fetchByUrl: { [proxyPermalink]: ok(meta({ video: 'v.mp4' })) },
    });
    expect(await build(providerWith(client), share)).toEqual({
      kind: 'rewritten-url',
      url: proxyPermalink, // the single-use xmt/slof share attribution is dropped
      sourceUrl: share,
    });
    // A landing-URL resolution would have probed the error page instead.
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([proxyPermalink]);
  });

  it('follows the legacy threads.net host through its extra /share/ hop', async () => {
    const legacyShare = 'https://www.threads.net/share/BAc3zqH7qQ/';
    const { client, fetch } = makeThreadsClient({
      chain: { [legacyShare]: ok([share, permalink]) },
      fetchByUrl: { [proxyPermalink]: ok(meta({ images: ['i.jpg'] })) },
    });
    expect(await build(providerWith(client), legacyShare)).toEqual({
      kind: 'rewritten-url',
      url: proxyPermalink,
      sourceUrl: legacyShare,
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([proxyPermalink]);
  });

  it('returns null and never probes when the redirect chase fails', async () => {
    const { client, fetch } = makeThreadsClient({
      chain: { [share]: err(invalidResponseError('threads')) },
    });
    expect(await build(providerWith(client), share)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null and never probes when the chain is empty (desktop-UA no-redirect case)', async () => {
    const { client, fetch } = makeThreadsClient({ chain: { [share]: ok([]) } });
    expect(await build(providerWith(client), share)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null and never probes when no hop is a Threads post permalink', async () => {
    const chains: readonly (readonly string[])[] = [
      ['https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2Fpost%2FDcp0Ly0iOIq'], // off-host
      ['https://www.threads.com/@ajit86403'], // profile, not a post
      ['https://www.threads.com/?error=invalid_post'], // bounce only
    ];
    for (const hops of chains) {
      const { client, fetch } = makeThreadsClient({ chain: { [share]: ok(hops) } });
      expect(await build(providerWith(client), share)).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('probes a plain post permalink directly, without a redirect chase', async () => {
    const { client, resolveRedirectChain } = makeThreadsClient({
      fetchByUrl: { [proxyPermalink]: ok(meta({ video: 'v.mp4' })) },
    });
    expect(await build(providerWith(client), permalink)).toEqual({
      kind: 'rewritten-url',
      url: proxyPermalink,
      sourceUrl: permalink,
    });
    expect(resolveRedirectChain).not.toHaveBeenCalled();
  });

  it('returns null (no bare link) when the resolved permalink yields no usable proxy', async () => {
    const { client, fetch } = makeThreadsClient({
      chain: { [share]: ok([permalink]) },
      fetchByUrl: { [proxyPermalink]: ok(meta({ title: 'Threads • 登入', images: ['logo.png'] })) },
    });
    expect(await build(providerWith(client), share)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Facebook share-link resolution + OpenGraph card fallback
// ---------------------------------------------------------------------------

describe('facebook share-link resolution + card fallback', () => {
  const share = 'https://www.facebook.com/share/r/1AcYfs5CNq/';
  const canonical = 'https://www.facebook.com/61585725097605/videos/866774919797953/';
  const proxyCanonical = 'https://facebed.com/61585725097605/videos/866774919797953/';
  const proxyShare = 'https://facebed.com/share/r/1AcYfs5CNq/';

  type ResolveResult = Result<string, LinkPreviewFailure>;

  /** Fake OgClient exposing BOTH the resolve step and the OG fetch. */
  const makeFbClient = (opts: {
    resolve?: Readonly<Record<string, ResolveResult>>;
    fetchByUrl?: Readonly<Record<string, MetaResult>>;
  }): {
    client: OgClient;
    fetch: ReturnType<typeof vi.fn>;
    resolveCanonical: ReturnType<typeof vi.fn>;
  } => {
    const fetch = vi.fn(
      async (url: string): Promise<MetaResult> => opts.fetchByUrl?.[url] ?? ok(meta()),
    );
    const resolveCanonical = vi.fn(
      async (url: string): Promise<ResolveResult> =>
        opts.resolve?.[url] ?? err(invalidResponseError('facebook')),
    );
    return { client: { fetch, resolveCanonical } as unknown as OgClient, fetch, resolveCanonical };
  };

  const build = async (
    provider: LinkPreviewProvider,
    href: string,
  ): Promise<LinkPreviewResult | null> => {
    const result = await provider.build(u(href), { timeoutMs: 1000 });
    if (!isOk(result)) throw new Error(`expected ok for ${href}`);
    return result.value;
  };

  it('expands a share link to its canonical permalink, then probes the proxy for a video', async () => {
    const { client, resolveCanonical, fetch } = makeFbClient({
      resolve: { [share]: ok(canonical) },
      fetchByUrl: { [proxyCanonical]: ok(meta({ video: 'v.mp4' })) },
    });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await build(provider, share)).toEqual({
      kind: 'rewritten-url',
      url: proxyCanonical,
      sourceUrl: share, // original link is carried, not the resolved canonical
    });
    expect(resolveCanonical).toHaveBeenCalledWith(share, 1000, 'facebook');
    expect(fetch).toHaveBeenCalledWith(proxyCanonical, 'facebook', 1000); // never the /share/ token
  });

  it('drops the share-attribution query from the resolved URL before probing', async () => {
    const { client } = makeFbClient({
      resolve: { [share]: ok(`${canonical}?share_url=x&rdid=y`) },
      fetchByUrl: { [proxyCanonical]: ok(meta({ video: 'v.mp4' })) },
    });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await build(provider, share)).toEqual({
      kind: 'rewritten-url',
      url: proxyCanonical,
      sourceUrl: share,
    });
  });

  it('falls back to a Facebook OpenGraph card when resolution fails and the proxy is a login wall', async () => {
    const fbImage = 'https://scontent.example/thumb.jpg';
    const { client } = makeFbClient({
      resolve: { [share]: err(invalidResponseError('facebook')) },
      fetchByUrl: {
        [proxyShare]: ok(meta({ title: 'Log in or sign up to view' })),
        [share]: ok(
          meta({
            title: 'Lil mouse',
            description: 'a clip',
            images: [fbImage],
            url: 'https://www.facebook.com/p/1/',
          }),
        ),
      },
    });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await build(provider, share)).toEqual({
      kind: 'card',
      card: {
        url: 'https://www.facebook.com/p/1/',
        title: 'Lil mouse',
        description: 'a clip',
        imageUrl: fbImage,
        siteName: 'Facebook',
      },
      sourceUrl: share,
    });
  });

  it('returns null when the proxy cannot preview AND Facebook serves only a junk OG', async () => {
    const { client } = makeFbClient({
      resolve: { [share]: err(invalidResponseError('facebook')) },
      fetchByUrl: {
        [proxyShare]: ok(meta({ title: 'Log in or sign up to view' })),
        [share]: ok(meta({ title: 'Log in or sign up to view' })),
      },
    });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await build(provider, share)).toBeNull();
  });

  it('does not resolve non-share canonical links (probes them directly)', async () => {
    const post = 'https://www.facebook.com/page/videos/123';
    const proxyPost = 'https://facebed.com/page/videos/123';
    const { client, resolveCanonical } = makeFbClient({
      fetchByUrl: { [proxyPost]: ok(meta({ video: 'v.mp4' })) },
    });
    const provider = createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client });
    expect(await build(provider, post)).toEqual({
      kind: 'rewritten-url',
      url: proxyPost,
      sourceUrl: post,
    });
    expect(resolveCanonical).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Facebook legacy album-photo normalisation
// ---------------------------------------------------------------------------

describe('facebook legacy album-photo normalisation', () => {
  const ALBUM = 'a.136355476386';
  const PHOTO_ID = '10160123456789';
  const legacy = `https://www.facebook.com/nasa/photos/${ALBUM}/${PHOTO_ID}/`;
  const idForm = `https://facebed.com/photo/?fbid=${PHOTO_ID}&set=${ALBUM}`;

  const providerWith = (
    byUrl: Readonly<Record<string, MetaResult>>,
  ): { provider: LinkPreviewProvider; fetch: ReturnType<typeof vi.fn> } => {
    const { client, fetch } = makeOgClient(byUrl);
    return {
      provider: createFacebookProvider({ proxyHosts: ['facebed.com'], ogClient: client }),
      fetch,
    };
  };

  const build = async (
    provider: LinkPreviewProvider,
    href: string,
  ): Promise<LinkPreviewResult | null> => {
    const result = await provider.build(u(href), { timeoutMs: 1000 });
    if (!isOk(result)) throw new Error(`expected ok for ${href}`);
    return result.value;
  };

  it('recognises the legacy album-photo permalink as previewable content', () => {
    const { provider } = providerWith({});
    expect(provider.canHandle(u(legacy))).toBe(true);
    expect(provider.canHandle(u('https://www.facebook.com/nasa/photos/a.101.202.303/9/'))).toBe(
      true,
    );
  });

  it('leaves an album listing and a non-album photo path alone', () => {
    const { provider } = providerWith({});
    expect(provider.canHandle(u('https://www.facebook.com/nasa/photos/'))).toBe(false);
    expect(provider.canHandle(u(`https://www.facebook.com/nasa/photos/${PHOTO_ID}/`))).toBe(false);
    expect(provider.canHandle(u('https://www.facebook.com/nasa/photos/a.abc/1/'))).toBe(false);
  });

  it('probes the id-addressed form, not the path form', async () => {
    // The proxy resolves the path form to an unrelated real post, which no
    // content filter can detect — only the ids name the right photo.
    const { provider, fetch } = providerWith({ [idForm]: ok(meta({ images: [POST_IMAGE] })) });
    expect(await build(provider, legacy)).toEqual({
      kind: 'rewritten-url',
      url: idForm,
      sourceUrl: legacy,
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([idForm]);
  });

  it('drops the legacy viewer query and normalises the multi-part album token', async () => {
    const multiPart = `https://www.facebook.com/nasa/photos/a.101.202.303/${PHOTO_ID}/?type=3&theater`;
    const expected = `https://facebed.com/photo/?fbid=${PHOTO_ID}&set=a.101.202.303`;
    const { provider, fetch } = providerWith({ [expected]: ok(meta({ video: 'v.mp4' })) });
    expect(await build(provider, multiPart)).toEqual({
      kind: 'rewritten-url',
      url: expected,
      sourceUrl: multiPart,
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([expected]);
  });

  it('probes every other Facebook path shape unchanged', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['https://www.facebook.com/nasa/posts/123', 'https://facebed.com/nasa/posts/123'],
      ['https://www.facebook.com/nasa/videos/123', 'https://facebed.com/nasa/videos/123'],
      ['https://www.facebook.com/reel/123', 'https://facebed.com/reel/123'],
      ['https://www.facebook.com/watch/?v=123', 'https://facebed.com/watch/?v=123'],
      [
        'https://www.facebook.com/permalink.php?story_fbid=1&id=2',
        'https://facebed.com/permalink.php?story_fbid=1&id=2',
      ],
    ];
    for (const [source, expected] of cases) {
      const { provider, fetch } = providerWith({ [expected]: ok(meta({ video: 'v.mp4' })) });
      expect(await build(provider, source)).toEqual({
        kind: 'rewritten-url',
        url: expected,
        sourceUrl: source,
      });
      expect(fetch.mock.calls.map((c) => c[0])).toEqual([expected]);
    }
  });
});

// ---------------------------------------------------------------------------
// Proxy punt: a probe finally served from the source site is never posted
// ---------------------------------------------------------------------------

describe('landsOnSource', () => {
  const domains = ['twitter.com', 'x.com'];

  it('matches the apex, www, and any deeper subdomain of a source domain', () => {
    expect(landsOnSource('https://x.com/jack/status/20', domains)).toBe(true);
    expect(landsOnSource('https://www.twitter.com/jack/status/20', domains)).toBe(true);
    expect(landsOnSource('https://mobile.Twitter.com/jack/status/20', domains)).toBe(true);
  });

  it('does not match the source CDN, look-alike hosts, or an unparseable URL', () => {
    expect(landsOnSource('https://video.twimg.com/v.mp4', domains)).toBe(false);
    expect(landsOnSource('https://fxtwitter.com/jack/status/20', domains)).toBe(false);
    expect(landsOnSource('https://notx.com/jack/status/20', domains)).toBe(false);
    expect(landsOnSource('not a url', domains)).toBe(false);
  });
});

describe('proxy punt back to the source site', () => {
  const HOSTS = ['mbdinstagram.com', 'kkinstagram.com'];
  const reel = 'https://www.instagram.com/reel/Dc2tQQNs7RF/';
  const mbd = 'https://mbdinstagram.com/reel/Dc2tQQNs7RF/';
  const kk = 'https://kkinstagram.com/reel/Dc2tQQNs7RF/';
  // What instagram.com serves the bot host once the proxy has 302'd there: a
  // genuine image card. Discord's crawler, following the same redirect from
  // its own address, gets "Login • Instagram" with no content.
  const punted = ok(
    meta({
      title: 'eva on Instagram: "Let\'s draw a circle together"',
      images: ['https://scontent.cdninstagram.com/v/t51/793573682_n.jpg'],
      finalUrl: 'https://www.instagram.com/reel/Dc2tQQNs7RF/',
    }),
  );

  it('skips a host that redirected to the source despite an image-bearing OG, logging at debug', async () => {
    const { client, fetch } = makeOgClient({
      [mbd]: punted,
      [kk]: ok(meta({ video: 'https://scontent.cdninstagram.com/v/reel.mp4', finalUrl: kk })),
    });
    const provider = createInstagramProvider({ proxyHosts: HOSTS, ogClient: client });
    const logger = makeLogger();
    expect(await buildUrl(provider, reel, { timeoutMs: 1000, logger })).toBe(kk);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'instagram', host: 'mbdinstagram.com' }),
      expect.stringContaining('redirected back to the source site'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips a punt landing on the bare apex host as well as on www', async () => {
    const { client } = makeOgClient({
      [mbd]: ok(meta({ images: ['i.jpg'], finalUrl: 'https://instagram.com/reel/Dc2tQQNs7RF/' })),
      [kk]: ok(meta({ images: ['k.jpg'] })),
    });
    const provider = createInstagramProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, reel)).toBe(kk);
  });

  it('returns null (no bare link) when every host punts to the source', async () => {
    const { client, fetch } = makeOgClient({ [mbd]: punted, [kk]: punted });
    const provider = createInstagramProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, reel)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a redirect to the source CDN as a real proxy answer, not a punt', async () => {
    const video = 'https://scontent.cdninstagram.com/v/reel.mp4';
    const { client } = makeOgClient({ [mbd]: ok(meta({ video, finalUrl: video })) });
    const provider = createInstagramProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, reel)).toBe(mbd);
  });

  it('ranks a candidate normally when the probe reports no final URL', async () => {
    const { client } = makeOgClient({ [mbd]: ok(meta({ images: ['i.jpg'] })) });
    const provider = createInstagramProvider({ proxyHosts: HOSTS, ogClient: client });
    expect(await buildUrl(provider, reel)).toBe(mbd);
  });

  it('recognises a punt onto a sibling source domain (x.com for a twitter.com link)', async () => {
    const fx = 'https://fxtwitter.com/jack/status/20';
    const vx = 'https://vxtwitter.com/jack/status/20';
    const { client } = makeOgClient({
      [fx]: ok(meta({ images: ['i.jpg'], finalUrl: 'https://x.com/jack/status/20' })),
      [vx]: ok(meta({ images: ['v.jpg'], finalUrl: vx })),
    });
    const provider = createTwitterProvider({
      proxyHosts: ['fxtwitter.com', 'vxtwitter.com'],
      ogClient: client,
    });
    expect(await buildUrl(provider, 'https://twitter.com/jack/status/20')).toBe(vx);
  });
});
