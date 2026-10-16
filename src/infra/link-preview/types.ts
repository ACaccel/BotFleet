/**
 * Link-preview provider types and Strategy interface. Providers return
 * neutral data only; Discord message assembly belongs to the infra/discord
 * renderer and the consuming plugin.
 *
 * Three preview mechanisms, one discriminated union:
 *   - `rewritten-url`: reply with a proxy-domain URL and let Discord unfurl it,
 *     because a bot-authored embed cannot render playable video. Rewrite
 *     providers probe their proxy hosts with the Discord crawler UA first and
 *     return the first that yields media, so a dead proxy is never posted.
 *   - `card`: OpenGraph data rendered with `EmbedBuilder`, or a Components V2
 *     card with an uploaded video below the metadata (Facebook and Threads).
 *   - `post`: a structured post from a JSON API (X), used for a video post only
 *     when no proxy yields playable video, so the renderer uploads it.
 *   - `gallery`: a multi-page work (nhentai, wnacg) the consumer turns into
 *     a paged reader; see `./gallery/`.
 *
 * Adding a provider: implement {@link LinkPreviewProvider} (or reuse
 * `createRewriteProvider`) under `providers/`, append its name to
 * {@link LinkPreviewProviderName}, and register it in
 * `createDefaultLinkPreviewRegistry` with its proxy-host dependency, the
 * plugin config's `<source>ProxyHosts` key, and a recommended list in each
 * bot's `config.example.json` — proxy hosts are operator configuration.
 *
 * Error contract: a fetching provider's `build()` returns transport / HTTP /
 * parse failures as a {@link LinkPreviewError} and never throws, so an
 * unavailable upstream never breaks the user's message.
 */
import type { Logger } from '../../core/logger';
import type { LinkPreviewError } from '../../core/errors';
import type { Result } from '../../core/result';

/**
 * Every supported source, as a single source of truth. The config zod
 * enum and the registry both derive from this tuple, so adding a provider
 * is one edit here (plus the provider file and the registry line).
 */
export const LINK_PREVIEW_PROVIDER_NAMES = [
  'twitter',
  'instagram',
  'threads',
  'facebook',
  'reddit',
  'bahamut',
  'bilibili',
  'nhentai',
  'wnacg',
] as const;

export type LinkPreviewProviderName = (typeof LINK_PREVIEW_PROVIDER_NAMES)[number];

/**
 * Widened {@link LinkPreviewError} used on the Err rail of every
 * provider. The params shape mirrors the LLM convention
 * (`{ provider, status }`) so the shared `errors:link_preview.*` catalog
 * templates render uniformly.
 */
export type LinkPreviewFailure = LinkPreviewError<{ provider: string; status: string }>;

/**
 * Neutral, Discord-agnostic preview data. The plugin's renderer turns a
 * card into an `EmbedBuilder`; keeping it plain data lets providers stay
 * unit-testable without discord.js.
 */
export interface PreviewCard {
  /** Canonical link the card points to (the embed title links here). */
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  /** Absolute image URL shown in the embed. */
  readonly imageUrl?: string;
  /** Complete image list in source order, when the card has multiple images. */
  readonly imageUrls?: readonly string[];
  /** Human-readable source label (e.g. `Bahamut`) for the embed footer. */
  readonly siteName?: string;
  /** Source-provided author details; omitted when unavailable. */
  readonly authorName?: string;
  readonly authorUrl?: string;
  /** Source-provided totals; compact strings preserve upstream rounding. */
  readonly engagement?: {
    readonly likes?: number | string;
    readonly comments?: number | string;
    readonly shares?: number | string;
  };
}

/** One downloadable encoding of a post's video. */
export interface PostVideoVariant {
  readonly url: string;
  /** Bits per second; with the duration it estimates the file size before download. */
  readonly bitrate: number;
}

/**
 * Neutral, Discord-agnostic social post. Counts are the upstream totals at
 * fetch time; an absent count was not reported and is not shown.
 */
export interface SocialPost {
  /** Canonical post link. */
  readonly url: string;
  readonly text: string;
  /** Creation time, epoch milliseconds. */
  readonly createdAt: number;
  readonly author: {
    readonly name: string;
    readonly handle: string;
    readonly url: string;
    readonly avatarUrl?: string;
  };
  /** Photo URLs in post order. */
  readonly images: readonly string[];
  readonly stats: {
    readonly replies?: number;
    readonly reposts?: number;
    readonly likes?: number;
    readonly views?: number;
  };
  readonly quote?: {
    readonly url: string;
    readonly text: string;
    readonly authorName: string;
    readonly authorHandle: string;
  };
  /** The post's first video, when it has one. */
  readonly video?: {
    readonly thumbnailUrl?: string;
    readonly durationSeconds: number;
    /** MP4 encodings, highest bitrate first. */
    readonly variants: readonly PostVideoVariant[];
  };
}

/** One page of a gallery, with its download candidates in preference order. */
export interface GalleryPage {
  /** Absolute HTTPS image URLs; later entries are mirrors tried after a failure. */
  readonly urls: readonly string[];
}

/** One tag group of a gallery (`artist`, `parody`, `tag`, ...), names in source order. */
export interface GalleryTagGroup {
  readonly type: string;
  readonly names: readonly string[];
}

/**
 * Neutral, Discord-agnostic multi-page gallery. Page URLs may carry
 * expiring signatures, so a consumer refetches the gallery rather than
 * keeping it indefinitely.
 */
export interface Gallery {
  readonly source: GallerySourceName;
  /** Source-local identifier, digits only. */
  readonly id: string;
  /** Canonical gallery link. */
  readonly url: string;
  readonly title: string;
  /** Secondary title (e.g. the original-language one), when it differs. */
  readonly subtitle?: string;
  readonly tags: readonly GalleryTagGroup[];
  readonly pages: readonly GalleryPage[];
  readonly favorites?: number;
  /** Upload time, epoch milliseconds. */
  readonly uploadedAt?: number;
}

/** The providers that yield a {@link Gallery} instead of a static preview. */
export const GALLERY_SOURCE_NAMES = [
  'nhentai',
  'wnacg',
] as const satisfies readonly LinkPreviewProviderName[];

export type GallerySourceName = (typeof GALLERY_SOURCE_NAMES)[number];

export const isGallerySourceName = (name: string): name is GallerySourceName =>
  (GALLERY_SOURCE_NAMES as readonly string[]).includes(name);

/**
 * The preview mechanisms, unified. `sourceUrl` is the original link
 * that matched, carried for logging / de-duplication.
 */
export type LinkPreviewResult =
  | { readonly kind: 'rewritten-url'; readonly url: string; readonly sourceUrl: string }
  | {
      readonly kind: 'card';
      readonly card: PreviewCard;
      readonly sourceUrl: string;
      readonly media?: { readonly url: string; readonly fallbackUrl: string };
    }
  | { readonly kind: 'post'; readonly post: SocialPost; readonly sourceUrl: string }
  | {
      readonly kind: 'gallery';
      readonly gallery: Gallery;
      /** 1-based page the link pointed at, already clamped to the gallery. */
      readonly startPage: number;
      readonly sourceUrl: string;
    };

/**
 * The results a single static reply can render. A gallery is interactive:
 * its consumer owns the paging message, so the shared renderer never sees one.
 */
export type RenderablePreviewResult = Exclude<LinkPreviewResult, { readonly kind: 'gallery' }>;

/** Per-call collaborators handed to {@link LinkPreviewProvider.build}. */
export interface LinkPreviewBuildContext {
  /**
   * Per-host hard timeout for any network the provider performs, in
   * milliseconds. A rewrite provider probes its whole host list, so this
   * times the list length is the worst case for one URL.
   */
  readonly timeoutMs: number;
  /** Optional scoped logger for provider-internal diagnostics. */
  readonly logger?: Logger;
}

/**
 * One provider per link type (Strategy). `canHandle` is a cheap, pure,
 * synchronous predicate over a parsed URL — it performs no network and
 * gates SSRF: a fetching provider only ever fetches a URL it matched,
 * and only against its own allow-listed host.
 */
export interface LinkPreviewProvider {
  readonly name: LinkPreviewProviderName;
  /** Pure host/path test. No network, no side effects. */
  canHandle(url: URL): boolean;
  /**
   * Produce a preview for a URL `canHandle` already accepted.
   * `Ok(null)` means "matched the host but this specific URL is not worth
   * a preview" (e.g. a profile page, or a page with no usable image) —
   * the caller skips it silently. `Err` means the provider should have
   * produced a preview but the upstream / parse failed.
   */
  build(
    url: URL,
    ctx: LinkPreviewBuildContext,
  ): Promise<Result<LinkPreviewResult | null, LinkPreviewFailure>>;
}
