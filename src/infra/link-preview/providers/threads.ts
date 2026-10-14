/**
 * Threads provider. Rewrites a post URL onto one of the operator-configured
 * embed-proxy domains so Discord renders an embed. Matches both the
 * `threads.net` and `threads.com` hosts.
 *
 * It also expands the `/share/<token>` short links the app's share button
 * emits: the token carries no post id, so every proxy serves a login wall for
 * it. Unlike Facebook's, the redirect is served only to a minimal User-Agent
 * (see {@link SHARE_RESOLVE_USER_AGENT}) and the permalink is an intermediate
 * hop, not the chain's destination (see {@link resolveShareLink}).
 *
 * Proxies differ per post type, so the probe loop's quality tiers pick one per
 * post rather than a fixed host. `fzthreads.com` serves `og:video` and the real
 * post image and resolves login-restricted posts; for a post without media it
 * answers with the author's avatar, which the weak-image tier ranks below real
 * post assets but above a text-only embed (see {@link LOW_VALUE_IMAGE_PATTERNS}).
 * `viewthreads.com` currently answers with a generic title that
 * {@link isPlaceholder} rejects; it stays listed as a fallback that recovers on
 * its own. A login wall's generic Instagram `og:image` is rejected by the
 * shared junk-marker filter. While every proxy is degraded, Threads previews
 * are skipped silently with no bare link posted.
 */
import { ok } from '../../../core/result';

import { createRewriteProvider } from './rewrite-provider';
import type { OgClient, OpenGraphMeta } from '../og-client';
import type { LinkPreviewBuildContext, LinkPreviewProvider } from '../types';

const PROVIDER_NAME = 'threads';

const THREADS_HOSTS: ReadonlySet<string> = new Set([
  'threads.net',
  'www.threads.net',
  'threads.com',
  'www.threads.com',
]);

/** `/@user/post/<id>` or `/t/<id>` — rejects profiles. */
const POST_PATH = /\/(?:post|t)\/[A-Za-z0-9._-]+/;

/** `/share/<token>` — anchored and token-bearing, so a bare `/share/` is not a share link. */
const SHARE_PATH = /^\/share\/[A-Za-z0-9._-]+\/?$/;

const isPostLink = (url: URL): boolean =>
  THREADS_HOSTS.has(url.hostname.toLowerCase()) && POST_PATH.test(url.pathname);

/** A `threads.com/share/<token>` short link whose token no proxy can resolve. */
const isShareLink = (url: URL): boolean =>
  THREADS_HOSTS.has(url.hostname.toLowerCase()) && SHARE_PATH.test(url.pathname);

const matches = (url: URL): boolean => isPostLink(url) || isShareLink(url);

/**
 * User-Agent used for the share-link redirect chase. Threads discriminates
 * on UA: a full desktop-browser UA (Chrome / Firefox, as sent by
 * `OgClient.resolveCanonical`) is served the single-page-app shell — HTTP
 * 200 with no `Location` header — and the short link is resolved
 * client-side, which a server-side chase can never observe. A minimal UA
 * receives the plain 30x chain instead, which is the only form that
 * exposes the permalink.
 */
const SHARE_RESOLVE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/** Build the candidate proxy URL for one host. The proxy keys off the path alone. */
const toProxyUrl = (url: URL, host: string): string => `https://${host}${url.pathname}`;

/**
 * `og:image` URLs that are the author's profile avatar rather than post
 * media. Two of the three proxies fall back to the avatar when a post
 * carries no media of its own, so without this the avatar card would tie
 * with a proxy that has the real post asset and could win the ordering.
 * Scoring such a candidate as a weak image keeps the real asset ahead of it.
 *
 * Both entries are fbcdn / cdninstagram path segments that mark an avatar
 * rendition — a heuristic on a CDN path convention, not a guarantee. If the
 * convention changes the only consequence is that an avatar card ranks as an
 * ordinary image again.
 */
const LOW_VALUE_IMAGE_PATTERNS: readonly RegExp[] = [/\/t51\.2885-19\//, /\/s150x150\//];

/** Some proxies answer an inaccessible post with only a generic account title. */
const isPlaceholder = (meta: OpenGraphMeta): boolean =>
  /^@\S+ on Threads$/i.test(meta.title?.trim() ?? '') &&
  (meta.description?.trim() ?? '') === '' &&
  meta.images.length === 0 &&
  (meta.video?.trim() ?? '') === '';

/**
 * Expand a Threads share short link to its canonical post permalink so the
 * proxy probe runs against a previewable URL. Returns `undefined` when the
 * chase fails or never passes through a post permalink.
 *
 * Every hop is inspected rather than just the chain's landing URL: the
 * share URL's single-use `xmt` token is rejected on the follow-up request,
 * so Threads bounces the chase onward to `threads.com/?error=invalid_post`
 * and the permalink survives only as an intermediate hop. Scanning in order
 * also covers the legacy `threads.net` host, whose share link needs an
 * extra 301 onto `threads.com` before the permalink appears.
 */
const resolveShareLink = async (
  url: URL,
  ctx: LinkPreviewBuildContext,
  ogClient: OgClient,
): Promise<URL | undefined> => {
  const chain = await ogClient.resolveRedirectChain(
    url.href,
    ctx.timeoutMs,
    PROVIDER_NAME,
    SHARE_RESOLVE_USER_AGENT,
  );
  if (!chain.ok) {
    ctx.logger?.debug(
      { provider: PROVIDER_NAME, code: chain.error.code },
      'social-link-preview: threads share-link resolution failed, skipping',
    );
    return undefined;
  }

  for (const hop of chain.value) {
    let candidate: URL;
    try {
      candidate = new URL(hop);
    } catch {
      continue;
    }
    // Only a real post permalink is previewable — this rejects the
    // `?error=invalid_post` bounce, profiles, the home page, and off-site hops.
    if (!isPostLink(candidate)) continue;
    // The post id lives in the path; the `xmt` / `slof` share-attribution
    // query is single-use noise that can only confuse a proxy.
    candidate.search = '';
    return candidate;
  }
  return undefined;
};

export const createThreadsProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
}): LinkPreviewProvider => {
  // Reuse the generic probe/validate machinery for the permalink.
  const rewrite = createRewriteProvider({
    name: PROVIDER_NAME,
    matches,
    sourceDomains: ['threads.net', 'threads.com'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    toProxyUrl,
    lowValueImagePatterns: LOW_VALUE_IMAGE_PATTERNS,
    isPlaceholder,
  });

  return {
    name: PROVIDER_NAME,
    canHandle: matches,
    build: async (url, ctx) => {
      if (isShareLink(url)) {
        const canonical = await resolveShareLink(url, ctx, opts.ogClient);
        // Unlike Facebook, an unresolved share link has no second chance:
        // probing the `/share/` path itself is pointless (the proxies answer
        // it with a login wall) and a self-scraped OpenGraph card is
        // impossible (threads.com serves the Discord crawler UA that same
        // login wall). Skip silently — no bare link, no broken card.
        if (canonical === undefined) return ok(null);
        const probe = await rewrite.build(canonical, ctx);
        if (!probe.ok) return probe;
        // Carry the original share link as sourceUrl (logging / de-dup), not
        // the permalink we resolved to.
        return ok(probe.value === null ? null : { ...probe.value, sourceUrl: url.href });
      }
      return rewrite.build(url, ctx);
    },
  };
};
