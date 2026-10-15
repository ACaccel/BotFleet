/**
 * Default {@link LinkPreviewProviderRegistry} wired with every production
 * provider, in priority order. Built via {@link createDefaultLinkPreviewRegistry}
 * so a test can construct its own partial registry.
 *
 * Every rewrite provider's proxy-host list is a required dependency. The
 * domains are third-party embed-fix services whose uptime and policies
 * change faster than releases ship, so they are operator configuration
 * (the plugin's `social_link_preview` block) and never code. Requiring the
 * fields forces a new rewrite provider to be given a configured list
 * rather than inheriting a stale built-in one. `enabledProviders` is the
 * kill-switch: a subset allow-list (from `config.providers`) drops any
 * source whose proxy is misbehaving.
 *
 * Adding a new provider:
 *   1. Implement {@link LinkPreviewProvider} (or reuse `createRewriteProvider`).
 *   2. Append its name to {@link LinkPreviewProviderName} in `./types`.
 *   3. Add one line to the `all` array below — and, for a rewrite provider,
 *      a required `<source>ProxyHosts` field to {@link LinkPreviewRegistryDeps}
 *      plus the matching operator config key.
 */
import {
  createDefaultGallerySources,
  createGalleryHttp,
  createGalleryPreviewProvider,
  type GallerySource,
} from './gallery';
import { OgClient } from './og-client';
import { LinkPreviewProviderRegistry } from './registry';
import { createBahamutProvider } from './providers/bahamut';
import { createBilibiliProvider } from './providers/bilibili';
import { createFacebookProvider } from './providers/facebook';
import { createInstagramProvider } from './providers/instagram';
import { createRedditProvider } from './providers/reddit';
import { createThreadsProvider } from './providers/threads';
import { createTwitterProvider } from './providers/twitter';
import type { LinkPreviewProvider, LinkPreviewProviderName } from './types';

/** Default OG-cache TTL for the shared fetcher (avoids hammering flaky proxies). */
const DEFAULT_OG_CACHE_TTL_MS = 10 * 60 * 1000;

interface LinkPreviewRegistryDeps {
  /** OpenGraph fetcher shared by validation + Bahamut; defaults to a cached {@link OgClient}. */
  readonly ogClient?: OgClient;
  /** Twitter/X embed-proxy hosts, probed in list order. */
  readonly twitterProxyHosts: readonly string[];
  /** FxTwitter-compatible API bases for custom X cards; omit to proxy every tweet. */
  readonly twitterApiBaseUrls?: readonly string[];
  /** Instagram embed-proxy hosts, probed in list order. */
  readonly instagramProxyHosts: readonly string[];
  /** Threads embed-proxy hosts, probed in list order. */
  readonly threadsProxyHosts: readonly string[];
  /** Facebook embed-proxy hosts, probed in list order. */
  readonly facebookProxyHosts: readonly string[];
  /** Reddit embed-proxy hosts, probed in list order. */
  readonly redditProxyHosts: readonly string[];
  /** Bilibili embed-proxy hosts, probed in list order. */
  readonly bilibiliProxyHosts: readonly string[];
  /**
   * Gallery sources (nhentai, wnacg); defaults to the production set. The
   * consumer passes the instances its paged reader also uses, so both share
   * one HTTP client and its connection pool.
   */
  readonly gallerySources?: readonly GallerySource[];
  /** When set, only these providers are registered (the kill-switch allow-list). */
  readonly enabledProviders?: readonly LinkPreviewProviderName[];
}

export const createDefaultLinkPreviewRegistry = (
  deps: LinkPreviewRegistryDeps,
): LinkPreviewProviderRegistry => {
  const ogClient = deps.ogClient ?? new OgClient({ cacheTtlMs: DEFAULT_OG_CACHE_TTL_MS });
  const all: readonly LinkPreviewProvider[] = [
    createTwitterProvider({
      proxyHosts: deps.twitterProxyHosts,
      ogClient,
      ...(deps.twitterApiBaseUrls === undefined ? {} : { apiBaseUrls: deps.twitterApiBaseUrls }),
    }),
    createInstagramProvider({ proxyHosts: deps.instagramProxyHosts, ogClient }),
    createThreadsProvider({ proxyHosts: deps.threadsProxyHosts, ogClient }),
    createFacebookProvider({ proxyHosts: deps.facebookProxyHosts, ogClient }),
    createRedditProvider({ proxyHosts: deps.redditProxyHosts, ogClient }),
    createBahamutProvider(ogClient),
    createBilibiliProvider({ proxyHosts: deps.bilibiliProxyHosts, ogClient }),
    ...(deps.gallerySources ?? createDefaultGallerySources(createGalleryHttp())).map(
      createGalleryPreviewProvider,
    ),
  ];
  const allow = deps.enabledProviders;
  const providers = allow === undefined ? all : all.filter((p) => allow.includes(p.name));
  return new LinkPreviewProviderRegistry(providers);
};
