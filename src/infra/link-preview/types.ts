/**
 * Link-preview provider types and Strategy interface.
 *
 * The link-preview Strategy lives in the infra layer (`src/infra/link-preview/`,
 * alongside `infra/llm/` and `infra/discord/`) because it is an outbound
 * boundary: providers either rewrite a URL to a third-party embed-proxy
 * domain or fetch a page's OpenGraph metadata. Discord-specific assembly
 * (building the embed, replying, suppressing the original) is the
 * consuming plugin's job — providers return neutral data only, so this
 * layer stays free of discord.js message I/O.
 *
 * Two preview mechanisms, one uniform result (discriminated union):
 *   - `rewritten-url`: reply with a proxy-domain URL and let DISCORD
 *     unfurl it into a playable video embed. A bot-authored embed cannot
 *     render playable video; attachments are sent separately.
 *     Rewrite providers VALIDATE before returning: they probe a priority
 *     list of proxy hosts (fetching each candidate's OpenGraph with the
 *     Discord crawler UA) and return the first that yields media — so a
 *     dead/empty proxy is never posted as a bare link.
 *   - `card`: neutral OpenGraph data rendered with `EmbedBuilder`, optionally
 *     carrying video metadata for separate attachment delivery (Facebook).
 *
 * Adding a new provider:
 *   1. Implement {@link LinkPreviewProvider} (or reuse `createRewriteProvider`
 *      for a proxy-rewrite source — it needs an `OgClient` for validation)
 *      in `src/infra/link-preview/providers/`.
 *   2. Append the name to {@link LinkPreviewProviderName} below.
 *   3. Add one line to `createDefaultLinkPreviewRegistry`
 *      (`src/infra/link-preview/default-registry.ts`) plus its required
 *      proxy-host field on `LinkPreviewRegistryDeps`, the matching
 *      `<source>ProxyHosts` key on the plugin's config schema, and a
 *      recommended list in each bot's `config.example.json` — proxy hosts
 *      are operator configuration, so a rewrite source is not usable until
 *      an operator can supply them.
 * The plugin's orchestrator does not branch on provider names internally.
 *
 * Error contract: a fetching provider's `build()` MUST translate
 * transport / HTTP / parse failures into a {@link LinkPreviewError} on
 * the Result's Err rail before returning. It never throws a
 * `DomainError`: a preview failure is logged and swallowed so the user's
 * message is never broken by an unavailable upstream.
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

/**
 * The two preview mechanisms, unified. `sourceUrl` is the original link
 * that matched, carried for logging / de-duplication.
 */
export type LinkPreviewResult =
  | { readonly kind: 'rewritten-url'; readonly url: string; readonly sourceUrl: string }
  | {
      readonly kind: 'card';
      readonly card: PreviewCard;
      readonly sourceUrl: string;
      readonly media?: { readonly url: string; readonly fallbackUrl: string };
    };

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
