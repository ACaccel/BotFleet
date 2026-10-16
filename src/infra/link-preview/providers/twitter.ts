/**
 * Twitter / X provider. Proxy hosts never match, so a link the user already
 * fixed is left untouched.
 *
 * With `apiBaseUrls` configured, the post is read from an FxTwitter-compatible
 * JSON API:
 *   - a post without video becomes a custom card (`post`);
 *   - a video post goes to the first proxy serving a playable `og:video`,
 *     because Discord plays a proxy's video at full quality while a bot can
 *     only upload a size-capped copy; failing that, it becomes a custom card
 *     and the renderer uploads the video;
 *   - a possibly sensitive post is left to a proxy, so Discord applies each
 *     viewer's sensitive-media setting;
 *   - when no API answers, the provider behaves as if none were configured.
 * Without `apiBaseUrls`, every tweet is rewritten onto a validated proxy.
 *
 * Proxy order matters: the FxEmbed family (`fxtwitter.com` and aliases)
 * publishes media via an `application/activity+json` link rather than
 * OpenGraph, so the probe grades its video tweets text-tier. Hosts serving
 * `og:video` must come first, or videos are re-uploaded instead of proxied.
 */
import { ok } from '../../../core/result';

import { fetchXStatus } from '../x-status';
import { createRewriteProbe } from './rewrite-provider';
import type { OgClient } from '../og-client';
import type { LinkPreviewProvider } from '../types';

const PROVIDER_NAME = 'twitter';

const TWITTER_HOSTS: ReadonlySet<string> = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

/** `/<user>/status/<id>` or `/i/web/status/<id>` — rejects profiles/search. */
const STATUS_PATH = /\/status(?:es)?\/(\d+)/;

const matches = (url: URL): boolean =>
  TWITTER_HOSTS.has(url.hostname.toLowerCase()) && STATUS_PATH.test(url.pathname);

export const createTwitterProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
  /** FxTwitter-compatible API bases, tried in order; omit to proxy every tweet. */
  apiBaseUrls?: readonly string[];
}): LinkPreviewProvider => {
  const probe = createRewriteProbe({
    name: PROVIDER_NAME,
    matches,
    sourceDomains: ['twitter.com', 'x.com'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    // Drop the query string (usually tracking params); the proxy needs only the path.
    toProxyUrl: (url, host) => `https://${host}${url.pathname}`,
  });
  const apiBaseUrls = opts.apiBaseUrls ?? [];

  return {
    name: PROVIDER_NAME,
    canHandle: matches,
    build: async (url, ctx) => {
      const proxied = async () => ok((await probe(url, ctx))?.preview ?? null);
      const id = STATUS_PATH.exec(url.pathname)?.[1];
      if (apiBaseUrls.length === 0 || id === undefined) return proxied();

      const status = await fetchXStatus(opts.ogClient, apiBaseUrls, id, ctx.timeoutMs);
      if (!status.ok) {
        ctx.logger?.debug(
          { provider: PROVIDER_NAME, code: status.error.code },
          'social-link-preview: x post API unavailable, falling back to a proxy link',
        );
        return proxied();
      }
      const { post, sensitive } = status.value;
      if (sensitive) return proxied();

      if (post.video !== undefined) {
        const candidate = await probe(url, ctx);
        if (candidate?.quality === 'video') return ok(candidate.preview);
      }
      return ok({ kind: 'post' as const, post, sourceUrl: url.href });
    },
  };
};
