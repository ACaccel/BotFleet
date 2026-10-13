/**
 * Instagram provider. Rewrites a post / reel / TV URL onto one of the
 * operator's configured embed-proxy domains so Discord renders a playable
 * embed. The priority list + per-host validation mitigates
 * Instagram's intermittent reel-video availability (bot-blocking): if the
 * first proxy returns only an image, a later one may yield the video.
 * Both the canonical `/reel/<id>` form and the author-prefixed
 * `/<username>/reel/<id>` form (produced by profile / share links) are
 * matched; bare profile URLs (`/<username>/`) are rejected — nothing to
 * preview.
 *
 * App share links (`/share/<token>`, `/share/reel/<token>`, `/share/p/<token>`)
 * carry an opaque token instead of a post id. They are passed to the proxies
 * unchanged: the InstaFix-family proxies resolve the token server-side, and
 * instagram.com serves this host only its single-page-app shell for them, so
 * a local redirect chase could not resolve them anyway. A proxy that fails to
 * resolve one answers with a placeholder that the junk-marker filter rejects.
 */
import { createRewriteProvider } from './rewrite-provider';
import type { OgClient } from '../og-client';
import type { LinkPreviewProvider } from '../types';

const INSTAGRAM_HOSTS: ReadonlySet<string> = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
]);

/**
 * `/p|reel|reels|tv/<id>`, optionally prefixed with the author handle
 * (`/<username>/reel/<id>` — the form profile / share links use). Rejects
 * bare profile URLs (`/<username>/`).
 */
const POST_PATH = /^\/(?:(?!share\/)[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/;

/**
 * `/share/<token>`, optionally typed (`/share/reel/<token>`, `/share/p/<token>`).
 * A bare type segment (`/share/reel/`) is not a token.
 */
const SHARE_PATH = /^\/share\/(?:(?:p|reel)\/)?(?!(?:p|reel)\/?$)[A-Za-z0-9_-]+\/?$/;

export const createInstagramProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
}): LinkPreviewProvider =>
  createRewriteProvider({
    name: 'instagram',
    matches: (url) =>
      INSTAGRAM_HOSTS.has(url.hostname.toLowerCase()) &&
      (POST_PATH.test(url.pathname) || SHARE_PATH.test(url.pathname)),
    sourceDomains: ['instagram.com'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    toProxyUrl: (url, host) => `https://${host}${url.pathname}`,
  });
