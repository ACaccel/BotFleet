/**
 * Construction parameters for the shipped feed platforms.
 *
 * These live in infra rather than in the plugin's config module because
 * two callers need the same defaults: the `social_feed` plugin, which
 * validates the whole block at composition time, and the composition
 * root, which builds the registry. One schema means a default can never
 * be raised in one place and missed in the other.
 */
import { z } from 'zod';
import { DEFAULT_X_API_BASE_URL } from './platforms/x-types';
import { DEFAULT_BAHAMUT_BASE_URL } from './platforms/bahamut-platform';

/** Hard cap so a typo cannot hold one upstream request open for minutes. */
const MAX_TIMEOUT_MS = 30_000;

const XPlatformConfigSchema = z
  .object({
    /** API origin. Point this at a self-hosted instance to avoid the public host. */
    apiBaseUrl: z.string().url().default(DEFAULT_X_API_BASE_URL),
    /** Per-request timeout, in milliseconds. */
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(8_000),
    /**
     * Proxy probed for playable videos and sensitive/API fallback posts.
     * Text and photo posts use the shared custom-card renderer.
     */
    embedProxyHost: z.string().min(1).default('fxtwitter.com'),
  })
  .strict();

const BahamutPlatformConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((raw) => {
        if (!URL.canParse(raw)) return false;
        const url = new URL(raw);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          url.pathname === '/'
        );
      }, 'baseUrl must be an HTTP(S) origin without credentials, path, query or fragment')
      .default(DEFAULT_BAHAMUT_BASE_URL),
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(8_000),
    maxPages: z.number().int().min(1).max(20).default(5),
  })
  .strict();

const YouTubePlatformConfigSchema = z
  .object({
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(8_000),
  })
  .strict();

/** Platforms omitted from this block are not registered. */
export const FeedPlatformsSchema = z
  .object({
    x: XPlatformConfigSchema.optional(),
    bahamut: BahamutPlatformConfigSchema.optional(),
    youtube: YouTubePlatformConfigSchema.optional(),
  })
  .strict();

export type FeedPlatformsConfig = z.infer<typeof FeedPlatformsSchema>;

/**
 * The `platforms` sub-block only, defaulted and validated.
 *
 * `.passthrough()` on the envelope is deliberate: validating the whole
 * `social_feed` block against `.strict()` is the plugin's job, and this
 * parser runs on the same raw object. Rejecting it here for carrying
 * `enabled` would make the two validations fight.
 *
 * @throws {z.ZodError} when `platforms` holds an unknown key or a value
 *   of the wrong type (fail-fast at composition time).
 */
export const parseFeedPlatformsConfig = (rawSocialFeedBlock: unknown): FeedPlatformsConfig =>
  z
    .object({ platforms: FeedPlatformsSchema.default({}) })
    .passthrough()
    .parse(rawSocialFeedBlock ?? {}).platforms;
