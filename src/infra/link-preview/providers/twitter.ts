/**
 * Twitter / X provider. Only original tweet hosts match — proxy hosts are
 * excluded so an already-fixed link the user posted is left untouched.
 *
 * With `apiBaseUrls` configured, the post is read from an FxTwitter-compatible
 * JSON API and rendered as a custom card, except where an embed proxy does
 * better:
 *   - a post without video becomes a custom card (`post`);
 *   - a video post is rewritten onto the first proxy that serves a playable
 *     `og:video`, because Discord plays a proxy's video natively at full
 *     quality while a bot can only upload a size-capped copy;
 *   - a video post that no proxy can play becomes a custom card, and the
 *     renderer uploads the video itself;
 *   - a post flagged possibly sensitive is left to a proxy, so Discord's
 *     unfurl applies each viewer's sensitive-media setting;
 *   - when no API answers, the provider behaves as if none were configured.
 * Without `apiBaseUrls` every tweet is rewritten onto a validated proxy.
 *
 * Host order matters for the proxy list: the FxEmbed family (`fxtwitter.com`
 * and its aliases) publishes media through an `application/activity+json`
 * alternate link rather than OpenGraph, so the validation probe sees no
 * `og:video` and grades a video tweet text-tier. A host that does serve
 * `og:video` therefore belongs ahead of it, or every video scores as a bare
 * title — and, with the API configured, is re-uploaded instead of proxied.
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
