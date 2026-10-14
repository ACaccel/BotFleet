/**
 * Configuration schema and defaults for the identity-sync plugin.
 *
 * Defaults live here in code (zod `.default()`), so a bot may declare an
 * empty / partial `identity_sync` block and still boot with a safe
 * (disabled) configuration. `.strict()` surfaces a mistyped key at startup.
 *
 * CJK note: `fallbackNickname` defaults to an empty string here on purpose.
 * The real fallback (e.g. a CJK display name) is supplied through
 * `config.json`, never a string literal in this `.ts` file — the i18n
 * scanner forbids CJK literals under `src/plugins`. An empty fallback means
 * "do not touch the nickname in fallback mode".
 */
import { z } from 'zod';

const ConfigSchema = z
  .object({
    /** Master switch. Off by default so the feature is strictly opt-in. */
    enabled: z.boolean().default(false),
    /**
     * When true, mirror a source user's identity (daily). When false, apply
     * the static fallback identity (`fallbackNickname` + `fallbackAvatarPath`).
     */
    syncWithSource: z.boolean().default(false),
    /** Discord user id to mirror when `syncWithSource` is true. */
    sourceUserId: z.string().default(''),
    /** Cron expression for the daily re-check. Defaults to 04:00 daily. */
    schedule: z.string().min(1).default('0 4 * * *'),
    /** Whether to sync the bot's avatar. */
    syncAvatar: z.boolean().default(true),
    /** Whether to sync the bot's per-guild nickname. */
    syncNickname: z.boolean().default(true),
    /**
     * Nickname applied in fallback mode (`syncWithSource: false`). Empty
     * means "leave the nickname untouched". Set via `config.json`.
     */
    fallbackNickname: z.string().default(''),
    /**
     * Avatar image used in fallback mode. A local file path (resolved from
     * the process working directory) or a URL; discord.js `setAvatar`
     * accepts both.
     */
    fallbackAvatarPath: z.string().min(1).default('assets/gopher.png'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A source-mirroring config that names no user cannot do anything; fail
    // fast at composition time rather than logging a fetch error every day.
    if (value.enabled && value.syncWithSource && value.sourceUserId.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUserId'],
        message: 'sourceUserId is required when syncWithSource is true',
      });
    }
  });

export type IdentitySyncPluginConfig = z.infer<typeof ConfigSchema>;

/**
 * An absent block yields the disabled defaults.
 *
 * @throws {z.ZodError} on an invalid block, including a source-mirroring
 *   config without its `sourceUserId`.
 */
export const parseIdentitySyncConfig = (raw: unknown): IdentitySyncPluginConfig =>
  ConfigSchema.parse(raw ?? {});
