/**
 * Configuration schema and defaults for the social-link-preview plugin.
 *
 * Scalars (the master switch, the original-message strategy, timeouts and
 * caps) default here in code, so a bot may omit the `social_link_preview`
 * block entirely — or declare an empty one — and still boot with a
 * fully-formed, safe (disabled) configuration.
 *
 * The six embed-proxy host lists are deliberately not defaulted: they name
 * third-party services whose uptime and policies change far faster than a
 * release ships, so they are operator configuration rather than code. Once
 * `enabled` is true every list is mandatory, and a missing one fails
 * startup with an issue naming the key — better than silently probing a
 * built-in host that went dark months ago. While the feature is disabled
 * the lists stay optional, so an operator can park it without discarding
 * the configuration.
 *
 * `.strict()` surfaces a mistyped key at startup rather than silently
 * ignoring it.
 */
import { z } from 'zod';

import { LINK_PREVIEW_PROVIDER_NAMES } from '../../infra/link-preview';

/** Hard cap so a typo cannot hold a single host probe open for minutes. */
const MAX_TIMEOUT_MS = 15_000;
/** Hard cap on previews per message, bounding reply fan-out / spam. */
const MAX_URLS_PER_MESSAGE = 5;

/**
 * One per-source embed-proxy host list, probed in priority (list) order.
 * Every message names both the key and the condition, so a startup failure
 * tells an operator exactly which line of `config.json` is missing.
 */
const proxyHostList = (key: string): z.ZodArray<z.ZodString, 'atleastone'> =>
  z
    .array(z.string().min(1), {
      required_error: `${key} is required when social_link_preview.enabled is true`,
      invalid_type_error: `${key} must be an array of embed-proxy host names`,
    })
    .nonempty(`${key} must list at least one embed-proxy host`);

/** Fields shared by both branches; all defaulted, none operator-mandatory. */
const commonShape = {
  /** Attachment downloads are bounded independently of metadata probes. */
  maxVideoBytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  videoTimeoutMs: z.number().int().positive().max(60_000).default(15_000),
  /** Other bots whose messages may trigger previews; self messages are always ignored. */
  allowedBotIds: z
    .array(
      z.string().regex(/^\d{17,20}$/, 'allowedBotIds must contain Discord user IDs (17-20 digits)'),
    )
    .default([]),
  /**
   * What to do with the user's original message once a preview is posted:
   *   - `suppress`: hide its auto-generated embed (needs ManageMessages);
   *   - `delete`: remove it entirely (needs ManageMessages);
   *   - `leave`: do nothing (may show two previews).
   */
  originalMessageStrategy: z.enum(['suppress', 'delete', 'leave']).default('suppress'),
  /**
   * FxTwitter-compatible JSON API bases (e.g. `https://api.fxtwitter.com`),
   * tried in order. Set to render X posts as custom cards; omit to rewrite
   * every tweet onto an embed proxy. Like the proxy lists, these name
   * third-party services and so are operator configuration with no default.
   */
  twitterApiBaseUrls: z
    .array(
      z
        .string()
        .url()
        .refine((value) => value.startsWith('https://'), 'twitterApiBaseUrls must use https'),
    )
    .nonempty('twitterApiBaseUrls must list at least one API base when set')
    .optional(),
  /**
   * Allow-list of enabled providers. Omitted = all providers. Acts as a
   * per-source kill-switch when a proxy service is misbehaving.
   */
  providers: z.array(z.enum(LINK_PREVIEW_PROVIDER_NAMES)).optional(),
  /**
   * Per-host OpenGraph probe / scrape timeout, in milliseconds. A rewrite
   * provider walks its whole host list, so this times the list length is
   * the worst case for one URL.
   */
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(4_000),
  /**
   * Maximum number of previews to post for a single message. Probing is
   * sequential, so worst-case per-message latency scales as
   * `maxUrlsPerMessage × hosts per list × timeoutMs`; keep this small.
   */
  maxUrlsPerMessage: z.number().int().positive().max(MAX_URLS_PER_MESSAGE).default(1),
};

/** The operator-supplied embed-proxy host lists, one per rewrite provider. */
const proxyHostsShape = {
  twitterProxyHosts: proxyHostList('twitterProxyHosts'),
  instagramProxyHosts: proxyHostList('instagramProxyHosts'),
  threadsProxyHosts: proxyHostList('threadsProxyHosts'),
  facebookProxyHosts: proxyHostList('facebookProxyHosts'),
  redditProxyHosts: proxyHostList('redditProxyHosts'),
  bilibiliProxyHosts: proxyHostList('bilibiliProxyHosts'),
};

/** Relaxes exactly the host lists on the disabled branch, nothing else. */
const proxyHostsOptionalMask = {
  twitterProxyHosts: true,
  instagramProxyHosts: true,
  threadsProxyHosts: true,
  facebookProxyHosts: true,
  redditProxyHosts: true,
  bilibiliProxyHosts: true,
} as const;

/**
 * Feature off. `enabled` is optional-with-default so an absent or empty
 * block still resolves to this branch; the host lists are accepted but
 * never read, so parking the feature costs no configuration.
 */
const DisabledSchema = z
  .object({
    enabled: z.literal(false).optional().default(false),
    ...commonShape,
    ...proxyHostsShape,
  })
  .partial(proxyHostsOptionalMask)
  .strict();

/** Feature on: every rewrite provider must be given a host list to probe. */
const EnabledSchema = z
  .object({
    enabled: z.literal(true),
    ...commonShape,
    ...proxyHostsShape,
  })
  .strict();

/**
 * Discriminating on `enabled` is what lets the composition root read the
 * six lists without a cast: narrowing the union hands it required fields.
 */
const ConfigSchema = z.discriminatedUnion('enabled', [DisabledSchema, EnabledSchema]);

export type SocialLinkPreviewPluginConfig = z.infer<typeof ConfigSchema>;

/**
 * Parse a raw `social_link_preview` config block into a validated config.
 * Passing `undefined` (the block is absent) yields the all-defaults,
 * disabled configuration rather than throwing.
 *
 * @throws {z.ZodError} when a provided value is the wrong type, an unknown
 *   key is present, or the feature is enabled without a complete set of
 *   embed-proxy host lists (fail-fast at composition time).
 */
export const parseSocialLinkPreviewConfig = (raw: unknown): SocialLinkPreviewPluginConfig =>
  ConfigSchema.parse(raw ?? {});
