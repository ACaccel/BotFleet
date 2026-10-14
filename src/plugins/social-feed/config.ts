/**
 * Configuration schema and defaults for the social-feed plugin.
 *
 * Only operating parameters live here. *What* is followed is stored in
 * each guild's database and edited with the `/feed` subcommands, so this
 * block never names an account or a channel: the poll cadence, the
 * per-pass cap, and the platform construction options are the whole of
 * it.
 *
 * Defaults live in code (zod `.default()`), so a bot may declare an
 * empty or partial `social_feed` block and still boot with a
 * fully-formed, safe (disabled) configuration. `.strict()` surfaces a
 * mistyped key inside the block at startup rather than silently
 * ignoring it.
 */
import { z } from 'zod';

import { FeedPlatformsSchema } from '../../infra/social-feed';

/**
 * Floor on the poll interval. The upstreams are free community
 * services; polling faster than this buys nothing (posts are not that
 * frequent) and only burns someone else's capacity.
 */
const MIN_POLL_INTERVAL_MS = 60_000;
/**
 * Node's `setTimeout` ceiling (2^31 - 1 ms, ~24.8 days). A larger delay
 * overflows the internal 32-bit counter and is silently coerced to 1 ms,
 * turning the poll loop into a near-tight spin.
 */
const MAX_POLL_INTERVAL_MS = 2_147_483_647;
/**
 * Hard cap on posts forwarded per subscription per pass. Bounds the
 * damage from a cursor reset or an upstream returning a stale page: at
 * worst a channel gets this many messages, not a whole timeline.
 */
const MAX_POSTS_PER_POLL = 20;

const ConfigSchema = z
  .object({
    /** Master switch. Off by default so the feature is strictly opt-in. */
    enabled: z.boolean().default(false),
    /** Delay between passes, in milliseconds. */
    pollIntervalMs: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_MS)
      .max(MAX_POLL_INTERVAL_MS)
      .default(300_000),
    /**
     * How many passes may use the cheap cursor path before one re-reads
     * the whole timeline.
     *
     * An upstream's `since` parameter is a strict `>`, so a post created
     * in the same second as the newest one already forwarded would stay
     * invisible for as long as that cursor holds — a permanent miss. A
     * periodic full read converts that into a bounded delay. `1` reads
     * fully every pass (correct, more bandwidth); the default reads
     * fully about once an hour at the default interval.
     */
    fullSweepEveryPolls: z.number().int().positive().default(12),
    /** Upper bound on posts forwarded per subscription per pass. */
    maxPostsPerPoll: z.number().int().positive().max(MAX_POSTS_PER_POLL).default(5),
    /**
     * Construction options for the platforms this bot can follow. A
     * platform absent from the block is not registered, which is how an
     * operator turns one off. Owned by `infra/social-feed` so the
     * composition root can build its registry from the same schema.
     */
    platforms: FeedPlatformsSchema.default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    // An enabled feed with no platform registered can only ever refuse
    // every subscription; surface it at composition time rather than
    // leaving an operator to wonder why nothing is ever forwarded.
    if (value.enabled && Object.keys(value.platforms).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['platforms'],
        message: 'platforms must not be empty when enabled is true',
      });
    }
  });

export type SocialFeedPluginConfig = z.infer<typeof ConfigSchema>;

/**
 * Parse a raw `social_feed` config block into a fully-defaulted,
 * validated config. Passing `undefined` (the block is absent) yields the
 * all-defaults, disabled configuration rather than throwing.
 *
 * @throws {z.ZodError} when a provided value is the wrong type, an
 *   unknown key is present, or an enabled feed configures no platform
 *   (fail-fast at composition time).
 */
export const parseSocialFeedConfig = (raw: unknown): SocialFeedPluginConfig =>
  ConfigSchema.parse(raw ?? {});
