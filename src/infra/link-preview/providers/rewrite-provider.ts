/**
 * Template for proxy-rewrite providers (Strategy + Template Method).
 *
 * Every video-capable source (Twitter/X, Instagram, Threads, Facebook)
 * shares one shape: a post URL is rewritten onto a third-party embed-proxy
 * domain so DISCORD unfurls it into a playable video / rich embed. Because
 * proxy domains die and vary in per-content support, the provider VALIDATES
 * before returning: it probes a priority-ordered list of proxy hosts,
 * fetching each candidate's OpenGraph (via {@link OgClient}, with the Discord
 * crawler UA so it sees exactly what Discord will), and picks the best:
 *
 *   - first host whose OG has a video  -> return immediately (playable);
 *   - else the first host with a post image (remembered, keep looking for video);
 *   - else the first host whose only images are low-value stand-ins — some
 *     proxies fall back to the author's avatar when they cannot resolve the
 *     post's own media, which is technically an image but carries none of the
 *     post's content, so it must lose to a proxy holding the real asset while
 *     still beating a bare title;
 *   - else the first host with a title  (text-only, weakest fallback);
 *   - else nothing usable -> `ok(null)` so the orchestrator skips silently
 *     and NO bare/dead link is ever posted.
 *
 * A candidate is ranked only if the proxy actually served it. When the probe
 * is finally served from the source site itself (`sourceDomains`) the proxy
 * has punted: it could not fetch the post and redirected to instagram.com /
 * x.com / ... instead. The OpenGraph read there is what the source serves to
 * THIS host's address, not what Discord's crawler will get from its own —
 * typically a login wall with a title and no content — so such a host is
 * skipped outright, however good its metadata looks.
 *
 * Per-host probe failures are logged at debug (proxy flakiness is expected),
 * never surfaced as `Err`, and never end the walk: every host is probed
 * until one yields a video or the list runs out, so a dead host early in
 * the list costs its `ctx.timeoutMs` and nothing more. That per-host
 * timeout is the only bound, which makes worst-case latency the list
 * length times the timeout — the operator keeps the lists short.
 *
 * The per-source files supply `matches` (pure predicate), the `proxyHosts`
 * list, and `toProxyUrl`. This file performs network I/O but returns only a
 * URL string — it must NOT import discord.js.
 */
import { ok, type Result } from '../../../core/result';

import type { OgClient, OpenGraphMeta } from '../og-client';
import type {
  LinkPreviewBuildContext,
  LinkPreviewFailure,
  LinkPreviewProvider,
  LinkPreviewProviderName,
  LinkPreviewResult,
} from '../types';

/** Preview quality of a probed candidate, best to worst. */
type CandidateQuality = 'video' | 'image' | 'weak-image' | 'text' | 'none';

/**
 * Placeholder text a proxy / source serves when the post is login-gated,
 * removed, region-blocked, or the proxy failed to fetch it — NOT a real
 * preview. Matched case-insensitively as a substring of `og:title` OR
 * `og:description`. Facebook's gated posts return "Log in or sign up to
 * view" (no media); vxReddit's error page returns the description "Failed
 * to get data from Reddit". Threads and its embed proxies serve a login
 * wall — in English or zh-TW depending on the page — that still carries a
 * generic Instagram logo as `og:image`, so without a marker it would score
 * as a usable image card. An Instagram proxy that cannot resolve a post
 * answers with its product name as the title and "Post not found" as the
 * description. Scoring any of these as a usable card would post a broken
 * embed.
 */
const JUNK_MARKERS: readonly string[] = [
  'log in or sign up',
  'log into facebook',
  'see posts, photos and more on facebook',
  'log in to instagram',
  'login • instagram',
  'log in with your instagram',
  // i18n-ignore: upstream login-wall page titles matched verbatim, not bot copy.
  '使用你的 instagram 登入',
  // i18n-ignore: upstream login-wall page title matched verbatim, not bot copy.
  'threads • 登入',
  'threads • log in',
  "this content isn't available",
  'content not found',
  'post not found',
  'page not found',
  'failed to get data from reddit',
];

/**
 * Titles that are exactly an embed-proxy's own name — the placeholder it
 * serves as `og:title` on a fetch error (e.g. vxReddit returns
 * `og:title="vxReddit"` when Reddit's API call fails).
 */
const JUNK_EXACT_TITLES: ReadonlySet<string> = new Set(['vxreddit', 'rxddit', 'fxreddit']);

const matchesJunkMarker = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return JUNK_MARKERS.some((marker) => normalized.includes(marker));
};

/**
 * True when `title` is a known login-wall / not-found / proxy-error
 * placeholder rather than real post content. Pure + exported for unit tests.
 */
export const isJunkPreviewTitle = (title: string): boolean =>
  matchesJunkMarker(title) || JUNK_EXACT_TITLES.has(title.trim().toLowerCase());

/**
 * A candidate whose only "content" is a junk placeholder (login-wall /
 * not-found / proxy-error) in its title or description. Exported so a
 * source that scrapes a page's own OpenGraph (e.g. the Facebook card
 * fallback) can reject the same gated placeholders before posting a card.
 */
export const isJunkPreview = (meta: OpenGraphMeta): boolean =>
  (meta.title !== undefined && isJunkPreviewTitle(meta.title)) ||
  (meta.description !== undefined && matchesJunkMarker(meta.description));

/**
 * True when `finalUrl` — where a probe was ultimately served from — sits on
 * one of the source site's registrable domains: the apex itself or any
 * subdomain (`www.`, `m.`, ...). An unparseable URL is not a source landing.
 * Pure + exported for unit tests.
 */
export const landsOnSource = (finalUrl: string, sourceDomains: readonly string[]): boolean => {
  let hostname: string;
  try {
    hostname = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return sourceDomains.some((domain) => {
    const normalized = domain.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
};

/**
 * True when every image the candidate offers matches a low-value pattern,
 * i.e. none of them is the post's own media. A single non-matching image is
 * enough to treat the candidate as carrying a real asset.
 */
const hasOnlyLowValueImages = (images: readonly string[], patterns: readonly RegExp[]): boolean =>
  images.every((image) => patterns.some((pattern) => pattern.test(image)));

/**
 * Rank a candidate proxy's OpenGraph: a playable video beats a post image
 * beats a low-value image beats a text-only embed beats nothing usable. A
 * login-wall / not-found / proxy-error placeholder (with no video) scores
 * `none` so a broken card is never posted. Pure + exported so the selection
 * policy can be tested in isolation from the probe loop.
 *
 * `lowValueImagePatterns` (per-source, optional) match image URLs that a
 * proxy serves as a stand-in for missing post media — an author avatar, say.
 * A candidate offering nothing but those scores `weak-image` so it yields to
 * any proxy that resolved the real asset. Without patterns every image is
 * taken at face value.
 */
export const scoreMeta = (
  meta: OpenGraphMeta,
  lowValueImagePatterns?: readonly RegExp[],
): CandidateQuality => {
  if (meta.video !== undefined && meta.video.length > 0) return 'video';
  // A login-wall / not-found / proxy-error page carries no real content even
  // if it serves a generic logo image, so reject it before the image/text tiers.
  if (isJunkPreview(meta)) return 'none';
  if (meta.images.length > 0) {
    const weak =
      lowValueImagePatterns !== undefined &&
      lowValueImagePatterns.length > 0 &&
      hasOnlyLowValueImages(meta.images, lowValueImagePatterns);
    return weak ? 'weak-image' : 'image';
  }
  if (meta.title !== undefined && meta.title.length > 0) return 'text';
  return 'none';
};

interface RewriteSpec {
  readonly name: LinkPreviewProviderName;
  /** Pure predicate: does this URL point at a previewable post on this source? */
  readonly matches: (url: URL) => boolean;
  /**
   * Registrable domains of the source site itself (`instagram.com`; both
   * `twitter.com` and `x.com` for X). A candidate whose probe is finally
   * served from one of these, apex or subdomain, is a proxy that punted back
   * to the source and is skipped — see {@link landsOnSource}.
   */
  readonly sourceDomains: readonly string[];
  /** Priority-ordered embed-proxy hosts to probe. Assumed non-empty (zod `.nonempty()`). */
  readonly proxyHosts: readonly string[];
  /** Build the candidate proxy URL for one host (e.g. host-swap, keep/drop query). */
  readonly toProxyUrl: (url: URL, host: string) => string;
  /**
   * Image URLs matching any of these are stand-ins a proxy serves when it has
   * no post media (e.g. the author's avatar), demoting a candidate offering
   * only such images to `weak-image`. Omit where every image is post media.
   */
  readonly lowValueImagePatterns?: readonly RegExp[];
  /** Reject source-specific placeholders before they can qualify as text-only cards. */
  readonly isPlaceholder?: (meta: OpenGraphMeta) => boolean;
  /** Shared validation fetcher. */
  readonly ogClient: OgClient;
}

const validate = async (
  spec: RewriteSpec,
  url: URL,
  ctx: LinkPreviewBuildContext,
): Promise<Result<LinkPreviewResult | null, LinkPreviewFailure>> => {
  let bestImage: string | undefined; // candidate whose OG had >=1 post image
  let bestWeakImage: string | undefined; // candidate whose images were all stand-ins
  let bestText: string | undefined; // candidate whose OG had only a title

  for (const host of spec.proxyHosts) {
    const candidate = spec.toProxyUrl(url, host);
    const res = await spec.ogClient.fetch(candidate, spec.name, ctx.timeoutMs);
    if (!res.ok) {
      ctx.logger?.debug(
        { provider: spec.name, host, code: res.error.code },
        'social-link-preview: proxy probe failed, trying next host',
      );
      continue;
    }
    if (res.value.finalUrl !== undefined && landsOnSource(res.value.finalUrl, spec.sourceDomains)) {
      // The proxy redirected back to the source: the metadata read there is
      // what the source serves to THIS host, not what Discord's crawler will
      // get (a login wall), so the candidate is unusable whatever it scored.
      ctx.logger?.debug(
        { provider: spec.name, host, finalUrl: res.value.finalUrl },
        'social-link-preview: proxy redirected back to the source site, trying next host',
      );
      continue;
    }
    if (spec.isPlaceholder?.(res.value) === true) continue;
    const quality = scoreMeta(res.value, spec.lowValueImagePatterns);
    if (quality === 'video') {
      // Best possible — playable video. Short-circuit.
      return ok({ kind: 'rewritten-url', url: candidate, sourceUrl: url.href });
    }
    // Neither image tier short-circuits: a later host may still hold the video.
    if (quality === 'image' && bestImage === undefined) {
      bestImage = candidate;
    } else if (quality === 'weak-image' && bestWeakImage === undefined) {
      bestWeakImage = candidate; // only worth posting if no real image turns up
    } else if (quality === 'text' && bestText === undefined) {
      bestText = candidate; // weakest fallback
    }
  }

  const chosen = bestImage ?? bestWeakImage ?? bestText;
  return ok(
    chosen === undefined ? null : { kind: 'rewritten-url', url: chosen, sourceUrl: url.href },
  );
};

export const createRewriteProvider = (spec: RewriteSpec): LinkPreviewProvider => ({
  name: spec.name,
  canHandle: (url) => spec.matches(url),
  build: (url, ctx) => validate(spec, url, ctx),
});
