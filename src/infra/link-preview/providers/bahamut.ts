/**
 * Bahamut (巴哈姆特, gamer.com.tw) provider. No public embed-proxy exists
 * for Bahamut, so this provider fetches the page's OpenGraph metadata via
 * the SSRF-safe {@link OgClient} and returns a neutral {@link PreviewCard}
 * the plugin renders into a static embed.
 *
 * `canHandle` restricts fetches to the `gamer.com.tw` domain (the SSRF
 * allow-list), minus the account host whose login / profile pages carry
 * nothing to preview. A page with no `og:image` or no `og:title` yields
 * `Ok(null)` — there is nothing better than Discord's default unfurl to
 * offer, so the caller skips it silently. So does the age-gate interstitial
 * an 18+ board serves anonymous visitors: it has an image (the gate
 * banner) and a description but no title, and none of it is the post.
 */
import { ok, type Result } from '../../../core/result';

import type { OgClient } from '../og-client';
import type {
  LinkPreviewBuildContext,
  LinkPreviewFailure,
  LinkPreviewProvider,
  LinkPreviewResult,
} from '../types';

const PROVIDER_NAME = 'bahamut';
/** Human-readable label for the embed footer when og:site_name is absent. */
const SITE_LABEL = 'Bahamut';

/** Login / account pages; never content worth a card. */
const ACCOUNT_HOSTS: ReadonlySet<string> = new Set(['user.gamer.com.tw']);

/** Matches `gamer.com.tw` and its content subdomains (forum/home/gnn/m/...). */
const isBahamutHost = (host: string): boolean =>
  (host === 'gamer.com.tw' || host.endsWith('.gamer.com.tw')) && !ACCOUNT_HOSTS.has(host);

/** The age-gate interstitial's banner image, served in place of the post's own. */
const AGE_GATE_IMAGE = /\/child-protection\.png(?:$|[?#])/i;

export const createBahamutProvider = (ogClient: OgClient): LinkPreviewProvider => ({
  name: PROVIDER_NAME,
  canHandle: (url) => isBahamutHost(url.hostname.toLowerCase()),
  build: async (
    url: URL,
    ctx: LinkPreviewBuildContext,
  ): Promise<Result<LinkPreviewResult | null, LinkPreviewFailure>> => {
    const result = await ogClient.fetch(url.href, PROVIDER_NAME, ctx.timeoutMs);
    if (!result.ok) return result;

    const og = result.value;
    const image = og.images[0];
    // No image to improve on, no title to show, or the age gate: skip rather
    // than post a card that says less than Discord's own unfurl.
    if (
      image === undefined ||
      AGE_GATE_IMAGE.test(image) ||
      og.title === undefined ||
      og.title.length === 0
    ) {
      return ok(null);
    }

    return ok({
      kind: 'card',
      card: {
        url: og.url ?? url.href,
        title: og.title,
        description: og.description,
        imageUrl: image,
        siteName: og.siteName ?? SITE_LABEL,
      },
      sourceUrl: url.href,
    });
  },
});
