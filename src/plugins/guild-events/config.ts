/**
 * Configuration schema and defaults for the guild-events plugin.
 *
 * Defaults live here in code (zod `.default()`), so a bot may omit the
 * `guild_events` block entirely and still get the intended behaviour.
 * `.strict()` surfaces a mistyped key at startup rather than silently
 * ignoring it.
 */
import { z } from 'zod';

/**
 * Outer bound on the retention window (one year). This field is the
 * privacy control for a copy of every recent attachment, so a typo that
 * turns 24 hours into effectively permanent retention must fail the
 * boot rather than pass validation.
 */
const MAX_TTL_HOURS = 24 * 365;

const AttachmentCacheSchema = z
  .object({
    /**
     * Master switch. On by default: without the cache, a deleted
     * attachment is usually already purged from Discord's CDN by the
     * time `messageDelete` arrives, so the forensic archive it feeds
     * would mostly hold nothing. Turning it off restores the
     * download-on-delete-only behaviour.
     */
    enabled: z.boolean().default(true),
    /**
     * How long a cached attachment survives before the hourly sweep
     * deletes it. This is the window during which a copy of every
     * recent attachment — not only deleted ones — sits on the bot host,
     * so it is the operator's privacy / disk trade-off to set.
     */
    ttlHours: z.number().finite().positive().max(MAX_TTL_HOURS).default(24),
    /**
     * Free space, in MiB, the cache volume must keep available. Below
     * it the cache stops writing new entries until space returns; the
     * delete-time archival paths keep running, since declining to
     * archive loses evidence rather than deferring it.
     *
     * This is availability protection, not a cache quota: a bot host
     * that runs its disk dry loses logging, the database, and the
     * archive the cache exists to feed.
     *
     * The check runs once per message, before its first byte, so a
     * value has to absorb what is already in flight when it trips —
     * up to the four process-wide download slots at 100 MB each. The
     * 5 GiB default leaves room for that plus all three consumers
     * above; a floor under ~1 GiB is one burst away from meaningless.
     */
    minFreeDiskMb: z.number().int().positive().default(5120),
  })
  .strict();

const ConfigSchema = z
  .object({
    attachment_cache: AttachmentCacheSchema.default({}),
  })
  .strict();

type GuildEventsPluginConfig = z.infer<typeof ConfigSchema>;

/** An absent block yields the defaults. */
export const parseGuildEventsConfig = (raw: unknown): GuildEventsPluginConfig =>
  ConfigSchema.parse(raw ?? {});
