/**
 * Unit tests for {@link LinkPreviewProviderRegistry} (first-match-wins by
 * registration order) and {@link createDefaultLinkPreviewRegistry}
 * (per-platform routing, the `enabledProviders` kill-switch, and the routing
 * of each operator-supplied proxy-host list to the provider that owns it).
 * Routing uses only the pure `canHandle`; every probing test injects a fake
 * `OgClient` so the suite stays offline.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LinkPreviewProviderRegistry,
  createDefaultLinkPreviewRegistry,
  type LinkPreviewProvider,
  type OgClient,
  type OpenGraphMeta,
} from '../../../../src/infra/link-preview';
import { ok } from '../../../../src/core/result';

const u = (href: string): URL => new URL(href);

/**
 * One distinct proxy host per source, so an assertion on the probed host
 * proves which list the provider was handed.
 */
const PROXY_HOSTS = {
  twitterProxyHosts: ['vxtwitter.com'],
  instagramProxyHosts: ['uuinstagram.com'],
  threadsProxyHosts: ['viewthreads.com'],
  facebookProxyHosts: ['facebed.com'],
  redditProxyHosts: ['vxreddit.com'],
  bilibiliProxyHosts: ['vxbilibili.com'],
} as const;

/** An OG stub answering every candidate with a playable video. */
const videoOgClient = (): OgClient => {
  const fetch = vi.fn(() => Promise.resolve(ok({ images: [], video: 'v.mp4' } as OpenGraphMeta)));
  return { fetch } as unknown as OgClient;
};

/** Probe `source` through the registry and return the rewritten proxy URL. */
const rewriteOf = async (
  registry: LinkPreviewProviderRegistry,
  source: string,
): Promise<string> => {
  const result = await registry.findProvider(u(source))?.build(u(source), { timeoutMs: 1_000 });
  if (result?.ok === true && result.value?.kind === 'card' && result.value.media !== undefined) {
    expect(result.value.card.siteName).toBe(
      source.includes('threads.net') ? 'Threads' : 'Facebook',
    );
    expect(result.value.media.url).toBe('v.mp4');
    return result.value.media.fallbackUrl;
  }
  if (result?.ok !== true || result.value?.kind !== 'rewritten-url') {
    throw new Error(`expected a rewritten-url result for ${source}`);
  }
  return result.value.url;
};

const stubProvider = (
  name: LinkPreviewProvider['name'],
  matches: (url: URL) => boolean,
): LinkPreviewProvider => ({
  name,
  canHandle: matches,
  build: () => Promise.resolve(ok(null)),
});

describe('LinkPreviewProviderRegistry.findProvider', () => {
  it('returns the first provider whose canHandle matches (registration order = priority)', () => {
    const first = stubProvider('twitter', () => true);
    const second = stubProvider('bahamut', () => true);
    const registry = new LinkPreviewProviderRegistry([first, second]);
    expect(registry.findProvider(u('https://anything/x'))).toBe(first);
  });

  it('returns undefined when no provider matches', () => {
    const registry = new LinkPreviewProviderRegistry([stubProvider('twitter', () => false)]);
    expect(registry.findProvider(u('https://anything/x'))).toBeUndefined();
  });
});

describe('createDefaultLinkPreviewRegistry', () => {
  it('routes each platform URL to its provider', () => {
    const registry = createDefaultLinkPreviewRegistry({ ...PROXY_HOSTS });
    expect(registry.findProvider(u('https://x.com/a/status/1'))?.name).toBe('twitter');
    expect(registry.findProvider(u('https://www.instagram.com/p/abc/'))?.name).toBe('instagram');
    expect(registry.findProvider(u('https://www.threads.net/@a/post/1'))?.name).toBe('threads');
    expect(registry.findProvider(u('https://www.facebook.com/a/posts/1'))?.name).toBe('facebook');
    expect(registry.findProvider(u('https://www.reddit.com/r/aww/comments/abc123/'))?.name).toBe(
      'reddit',
    );
    expect(registry.findProvider(u('https://forum.gamer.com.tw/C.php?bsn=1'))?.name).toBe(
      'bahamut',
    );
    expect(registry.findProvider(u('https://www.bilibili.com/video/BV1xx411c7mD'))?.name).toBe(
      'bilibili',
    );
    expect(registry.findProvider(u('https://b23.tv/mHCI3y3'))?.name).toBe('bilibili');
    expect(registry.findProvider(u('https://nhentai.net/g/123456/'))?.name).toBe('nhentai');
    expect(registry.findProvider(u('https://www.wnacg.com/photos-index-aid-1.html'))?.name).toBe(
      'wnacg',
    );
  });

  it('honours the enabledProviders allow-list', () => {
    const registry = createDefaultLinkPreviewRegistry({
      ...PROXY_HOSTS,
      enabledProviders: ['twitter'],
    });
    expect(registry.findProvider(u('https://x.com/a/status/1'))?.name).toBe('twitter');
    expect(registry.findProvider(u('https://forum.gamer.com.tw/C.php?bsn=1'))).toBeUndefined();
  });

  it('hands every source its own proxy-host list', async () => {
    const registry = createDefaultLinkPreviewRegistry({
      ...PROXY_HOSTS,
      ogClient: videoOgClient(),
    });
    const probed = {
      twitter: await rewriteOf(registry, 'https://x.com/a/status/1'),
      instagram: await rewriteOf(registry, 'https://www.instagram.com/p/abc/'),
      threads: await rewriteOf(registry, 'https://www.threads.net/@a/post/1'),
      facebook: await rewriteOf(registry, 'https://www.facebook.com/a/posts/1'),
      reddit: await rewriteOf(registry, 'https://www.reddit.com/r/aww/comments/abc123/'),
      bilibili: await rewriteOf(registry, 'https://www.bilibili.com/video/BV1xx411c7mD'),
    };
    expect(Object.values(probed).map((href) => new URL(href).hostname)).toEqual([
      'vxtwitter.com',
      'uuinstagram.com',
      'viewthreads.com',
      'facebed.com',
      'vxreddit.com',
      'vxbilibili.com',
    ]);
  });

  it('applies a custom proxy-host list (validated offline via injected OgClient)', async () => {
    const candidate = 'https://fixupx.com/a/status/1';
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        ok((url === candidate ? { images: [], video: 'v.mp4' } : { images: [] }) as OpenGraphMeta),
      ),
    );
    const ogClient = { fetch } as unknown as OgClient;
    const registry = createDefaultLinkPreviewRegistry({
      ...PROXY_HOSTS,
      twitterProxyHosts: ['fixupx.com'],
      ogClient,
    });
    expect(await rewriteOf(registry, 'https://x.com/a/status/1')).toBe(candidate);
  });
});
