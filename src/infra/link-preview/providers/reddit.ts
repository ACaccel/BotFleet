/**
 * Reddit provider. Rewrites a post URL onto one of the operator's configured
 * embed-proxy domains so Discord renders a playable video / rich
 * embed. Reddit videos live on `v.redd.it` and Discord does not unfurl them
 * natively, so the proxy (which serves the post's OpenGraph / Twitter-card
 * via Reddit's API) is the only path to a real preview.
 *
 * Every Reddit proxy is subject to Reddit's API restrictions and degrades by
 * serving an error placeholder rather than by failing outright, so the
 * per-host validation is what keeps a broken card off the channel (see
 * `scoreMeta` / `isJunkPreviewTitle`). Matches comment permalinks
 * (`/r/<sub>/comments/<id>`, the bare `/comments/<id>`) and the mobile
 * share form (`/r/<sub>/s/<token>`); bare subreddit / profile URLs are
 * rejected. The `redd.it/<id>` short link and the `/gallery/<id>` image-post
 * form both carry the post id, so they are rewritten onto the proxy as the
 * equivalent `/comments/<id>` permalink without a network round-trip.
 * `v.redd.it` is not matched: its id names the video asset, not the post,
 * and only Reddit itself can map one to the other.
 */
import { createRewriteProvider } from './rewrite-provider';
import type { OgClient } from '../og-client';
import type { LinkPreviewProvider } from '../types';

const REDDIT_HOSTS: ReadonlySet<string> = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'amp.reddit.com',
  'sh.reddit.com',
]);

/** Reddit's official post short-link hosts; the path is the bare post id. */
const SHORT_HOSTS: ReadonlySet<string> = new Set(['redd.it', 'www.redd.it']);

/** `/comments/<id>` (with or without `/r/<sub>`) or a `/r/<sub>/s/<token>` share link. */
const POST_PATH = /\/comments\/[a-z0-9]+|\/r\/[^/]+\/s\/[a-z0-9]+/i;

/** `/gallery/<id>` — an image post addressed by its post id. */
const GALLERY_PATH = /^\/gallery\/([a-z0-9]+)\/?$/i;

/** `redd.it/<id>` — the short link's whole path is the post id. */
const SHORT_PATH = /^\/([a-z0-9]+)\/?$/i;

/** The post id of a short link or gallery URL, which the proxies only accept as a permalink. */
const permalinkId = (url: URL): string | undefined => {
  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return SHORT_PATH.exec(url.pathname)?.[1];
  if (REDDIT_HOSTS.has(host)) return GALLERY_PATH.exec(url.pathname)?.[1];
  return undefined;
};

const matches = (url: URL): boolean =>
  permalinkId(url) !== undefined ||
  (REDDIT_HOSTS.has(url.hostname.toLowerCase()) && POST_PATH.test(url.pathname));

/** Drop the query (Reddit share links carry only tracking params); the proxy needs only the path. */
const toProxyUrl = (url: URL, host: string): string => {
  const id = permalinkId(url);
  return id === undefined ? `https://${host}${url.pathname}` : `https://${host}/comments/${id}`;
};

export const createRedditProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
}): LinkPreviewProvider =>
  createRewriteProvider({
    name: 'reddit',
    matches,
    sourceDomains: ['reddit.com', 'redd.it'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    toProxyUrl,
  });
