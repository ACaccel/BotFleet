/**
 * Facebook custom-card provider. Validated proxy metadata supplies post text,
 * images and optional video URLs; Facebook's own OpenGraph is the fallback.
 * Share links are expanded before probing because their tokens are not post
 * IDs. Legacy album photos use the id-addressed query form so a proxy cannot
 * resolve the path to an unrelated post. Queries carrying content IDs are
 * preserved. Media downloads and Discord delivery belong to the renderer.
 */
import { ok, type Result } from '../../../core/result';

import { createRewriteProvider, isJunkPreview } from './rewrite-provider';
import { parseFacebookEngagement } from './facebook-engagement';
import type { OgClient, OpenGraphMeta } from '../og-client';
import type {
  LinkPreviewBuildContext,
  LinkPreviewFailure,
  LinkPreviewProvider,
  LinkPreviewResult,
} from '../types';

const PROVIDER_NAME = 'facebook';
/** Source label used by the Facebook card renderer. */
const SITE_LABEL = 'Facebook';

const FACEBOOK_HOSTS: ReadonlySet<string> = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
]);

/** Path shapes that carry a previewable post/video/reel. */
const POST_PATH =
  /\/(?:posts|videos|reel|reels|share|watch|permalink\.php|story\.php)\b|^\/groups\/[^/]+\/permalink\/\d+/i;

/**
 * Single-photo viewer (`/photo/?fbid=<id>` or `/photo.php?fbid=<id>`). The
 * photo id lives in the query, so the path alone does not identify content.
 */
const PHOTO_PATH = /^\/photo(?:\.php)?\/?$/i;

/**
 * Legacy album-photo permalink: `/<owner>/photos/<album>/<photoId>/`, where the
 * album segment always carries the `a.` prefix (optionally followed by further
 * numeric id parts) and the photo id is numeric. The prefix and the numeric
 * shape are what separate this permalink from an ordinary `/photos/` listing,
 * which carries no single photo to preview.
 */
const LEGACY_ALBUM_PHOTO_PATH = /^\/[^/]+\/photos\/(a\.\d+(?:\.\d+)*)\/(\d+)\/?$/i;

/** A URL that points at one previewable piece of content, not a listing or profile. */
const isContentUrl = (url: URL): boolean =>
  POST_PATH.test(url.pathname) ||
  LEGACY_ALBUM_PHOTO_PATH.test(url.pathname) ||
  (PHOTO_PATH.test(url.pathname) && /^\d+$/.test(url.searchParams.get('fbid') ?? ''));

/** `fb.watch` short links are always a single video, regardless of path. */
const isFbWatch = (host: string): boolean => host === 'fb.watch' || host === 'www.fb.watch';

const matches = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  if (isFbWatch(host)) return true;
  return FACEBOOK_HOSTS.has(host) && isContentUrl(url);
};

/** A `facebook.com/share/<type>/<token>` short link that proxies cannot resolve. */
const isShareLink = (url: URL): boolean =>
  FACEBOOK_HOSTS.has(url.hostname.toLowerCase()) && /^\/share\//i.test(url.pathname);

/**
 * Address a legacy album-photo permalink by id — `/photo/?fbid=<photoId>&set=<album>`
 * — and return every other URL unchanged.
 *
 * The embed proxies resolve the legacy path form to a DIFFERENT, unrelated
 * post: the response carries genuine content (real title, real media, another
 * author), so no junk-marker filter can tell it apart from a true preview and
 * the bot would embed a stranger's post under the poster's link. The id form
 * names the photo unambiguously and resolves to the right one. The rest of the
 * query is dropped with the path it belonged to — the two ids are all the
 * proxy needs to resolve the photo.
 */
const normalizeAlbumPhotoUrl = (url: URL): URL => {
  if (!FACEBOOK_HOSTS.has(url.hostname.toLowerCase())) return url;
  const match = LEGACY_ALBUM_PHOTO_PATH.exec(url.pathname);
  const album = match?.[1];
  const photoId = match?.[2];
  if (album === undefined || photoId === undefined) return url;

  const normalized = new URL(url.href);
  normalized.pathname = '/photo/';
  normalized.search = `?fbid=${photoId}&set=${album}`;
  return normalized;
};

/** Build the candidate proxy URL for one host. Keep the query (FB ids live there). */
const toProxyUrl = (url: URL, host: string): string =>
  `https://${host}${url.pathname}${url.search}`;

/** Only source-owned HTTPS URLs may become clickable card links. */
const facebookLink = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      FACEBOOK_HOSTS.has(url.hostname.toLowerCase()) &&
      url.username === '' &&
      url.password === ''
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A source-owned link that also names one piece of content. facebed can
 * report a hashtag page as `og:url` when a post's text starts with a tag, and
 * the card title must not link there instead of to the post.
 */
const facebookContentLink = (value: string | undefined): string | undefined => {
  const link = facebookLink(value);
  return link !== undefined && isContentUrl(new URL(link)) ? link : undefined;
};

const facebookPreview = (url: URL, fallbackUrl: string, og: OpenGraphMeta): LinkPreviewResult => {
  const engagement = parseFacebookEngagement(og.siteName);
  return {
    kind: 'card',
    card: {
      url: facebookContentLink(og.url) ?? url.href,
      title: og.title,
      description: og.description,
      imageUrl: og.images[0],
      ...(og.images.length > 1 ? { imageUrls: og.images } : {}),
      siteName: SITE_LABEL,
      ...(og.authorName === undefined ? {} : { authorName: og.authorName }),
      ...(facebookLink(og.authorUrl) === undefined
        ? {}
        : { authorUrl: facebookLink(og.authorUrl) }),
      ...(engagement === undefined ? {} : { engagement }),
    },
    sourceUrl: url.href,
    ...(og.video === undefined ? {} : { media: { url: og.video, fallbackUrl } }),
  };
};

/**
 * Expand a Facebook share short link to its canonical permalink so the proxy
 * probe runs against a previewable URL. Returns the canonical URL, or
 * `undefined` when resolution fails or does not reach a real content
 * permalink (the caller then probes the original and/or falls back to a card).
 */
const resolveShareLink = async (
  url: URL,
  ctx: LinkPreviewBuildContext,
  ogClient: OgClient,
): Promise<URL | undefined> => {
  const resolved = await ogClient.resolveCanonical(url.href, ctx.timeoutMs, PROVIDER_NAME);
  if (!resolved.ok) {
    ctx.logger?.debug(
      { provider: PROVIDER_NAME, code: resolved.error.code },
      'social-link-preview: facebook share-link resolution failed, falling back',
    );
    return undefined;
  }
  let canonical: URL;
  try {
    canonical = new URL(resolved.value);
  } catch {
    return undefined;
  }
  // Only trust a resolution that lands on a real Facebook content permalink
  // (not another /share/ hop, a profile, or an off-site host).
  if (!FACEBOOK_HOSTS.has(canonical.hostname.toLowerCase())) return undefined;
  if (isShareLink(canonical) || !isContentUrl(canonical)) return undefined;
  // The redirect's `share_url` / `rdid` query is attribution noise that can
  // only confuse the proxy. A photo viewer is the exception: its id is the query.
  if (!PHOTO_PATH.test(canonical.pathname)) canonical.search = '';
  return canonical;
};

/**
 * Fetch Facebook's own OpenGraph when no proxy can preview the link.
 * Skip login walls, removed placeholders and pages without usable content.
 */
const buildFacebookCard = async (
  url: URL,
  ctx: LinkPreviewBuildContext,
  ogClient: OgClient,
): Promise<Result<LinkPreviewResult | null, LinkPreviewFailure>> => {
  const result = await ogClient.fetch(url.href, PROVIDER_NAME, ctx.timeoutMs);
  if (!result.ok) return result;

  const og = result.value;
  const image = og.images[0];
  // A login wall or a page without usable content is not worth a card.
  if (
    isJunkPreview(og) ||
    (image === undefined && og.video === undefined && og.title === undefined)
  )
    return ok(null);

  return ok(facebookPreview(url, url.href, og));
};

export const createFacebookProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
}): LinkPreviewProvider => {
  // Reuse the generic probe/validate machinery for the canonical URL.
  const rewrite = createRewriteProvider({
    name: PROVIDER_NAME,
    matches,
    sourceDomains: ['facebook.com', 'fb.watch'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    toProxyUrl,
    toResult: facebookPreview,
  });

  return {
    name: PROVIDER_NAME,
    canHandle: matches,
    build: async (url, ctx) => {
      // Expand a share short link before probing; otherwise probe as-is.
      const canonical = isShareLink(url)
        ? ((await resolveShareLink(url, ctx, opts.ogClient)) ?? url)
        : url;
      // A share link can expand onto the album-photo shape, so normalise last.
      const base = normalizeAlbumPhotoUrl(canonical);

      const probe = await rewrite.build(base, ctx);
      if (!probe.ok) return probe;
      if (probe.value !== null) {
        let preview = probe.value;
        // A proxy may redirect straight to video and carry no post text.
        // Enrich from the source without discarding validated media on failure.
        if (
          preview.kind === 'card' &&
          preview.media !== undefined &&
          !preview.card.title &&
          !preview.card.description
        ) {
          const source = await opts.ogClient.fetch(url.href, PROVIDER_NAME, ctx.timeoutMs);
          if (
            source.ok &&
            !isJunkPreview(source.value) &&
            (source.value.title || source.value.description || source.value.authorName)
          ) {
            const enriched = facebookPreview(url, preview.media.fallbackUrl, source.value);
            if (enriched.kind === 'card') {
              preview = {
                ...preview,
                card: {
                  ...enriched.card,
                  url: facebookContentLink(source.value.url) ?? preview.card.url,
                  imageUrl: preview.card.imageUrl ?? enriched.card.imageUrl,
                  imageUrls: preview.card.imageUrls ?? enriched.card.imageUrls,
                  ...(preview.card.engagement === undefined
                    ? {}
                    : {
                        engagement: preview.card.engagement,
                      }),
                },
              };
            }
          }
        }
        // Carry the original link as sourceUrl (logging / de-dup), not the
        // intermediate canonical we resolved to.
        return ok({ ...preview, sourceUrl: url.href });
      }
      const fallback = await buildFacebookCard(url, ctx, opts.ogClient);
      // A cookieless browser chase can fail while crawler metadata still
      // identifies the permalink. Retry only a validated source-owned URL.
      if (fallback.ok && fallback.value?.kind === 'card' && isShareLink(url)) {
        const permalink = new URL(fallback.value.card.url);
        if (matches(permalink) && !isShareLink(permalink) && permalink.href !== base.href) {
          const retry = await rewrite.build(normalizeAlbumPhotoUrl(permalink), ctx);
          if (retry.ok && retry.value?.kind === 'card') {
            const source = fallback.value.card;
            const card = retry.value.card;
            return ok({
              ...retry.value,
              card: {
                ...card,
                url: source.url,
                title: card.title ?? source.title,
                description: card.description ?? source.description,
                imageUrl: card.imageUrl ?? source.imageUrl,
                imageUrls: card.imageUrls ?? source.imageUrls,
                ...((card.engagement ?? source.engagement)
                  ? {
                      engagement: card.engagement ?? source.engagement,
                    }
                  : {}),
                ...((card.authorName ?? source.authorName)
                  ? {
                      authorName: card.authorName ?? source.authorName,
                    }
                  : {}),
                ...((card.authorUrl ?? source.authorUrl)
                  ? {
                      authorUrl: card.authorUrl ?? source.authorUrl,
                    }
                  : {}),
              },
              sourceUrl: url.href,
            });
          }
        }
      }
      return fallback;
    },
  };
};
