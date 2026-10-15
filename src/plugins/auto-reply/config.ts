/**
 * Configuration schema and defaults for the auto-reply plugin.
 *
 * The per-user "lucky reply" behaviour is pure operator data: which
 * Discord user it targets, how often it fires, and what it says are all
 * facts about one server's in-jokes, not about the bot. Keeping them in
 * `config.json` means adding or retiring one is a config edit, and the
 * lines stay out of the translation catalog — they are a specific
 * person's running gag, not bot copy with a locale.
 *
 * `.strict()` surfaces a mistyped key at startup rather than silently
 * ignoring it. Every field defaults, so a bot may omit the `auto_reply`
 * block entirely and still boot with lucky replies switched off.
 */
import { z } from 'zod';

/** One user-targeted lucky reply. */
const LuckyReplySchema = z
  .object({
    /** Required for public guild-settings mode; legacy personalities retain unbound entries. */
    guildId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    /**
     * Discord user id the reply is scoped to. Shape-checked: a typo'd
     * snowflake would otherwise parse and then simply never match,
     * with nothing to show the operator why.
     */
    userId: z
      .string()
      .regex(/^\d{17,20}$/, 'luckyReplies[].userId must be a Discord user id (17-20 digits)'),
    /** Firing chance per eligible message, 0–1. */
    probability: z
      .number()
      .min(0, 'luckyReplies[].probability must be between 0 and 1')
      .max(1, 'luckyReplies[].probability must be between 0 and 1'),
    /** Literal text sent to the channel. */
    reply: z.string().min(1, 'luckyReplies[].reply must be non-empty'),
  })
  .strict();

const ConfigSchema = z
  .object({
    luckyReplies: z.array(LuckyReplySchema).default([]),
    /**
     * Chance that any eligible message triggers the DB-backed `[*]`
     * lookup. Independent of {@link LuckyReplySchema}, which is
     * per-user.
     */
    globalLuckyProbability: z
      .number()
      .min(0, 'globalLuckyProbability must be between 0 and 1')
      .max(1, 'globalLuckyProbability must be between 0 and 1')
      .default(0.005),
  })
  .strict();

type AutoReplyPluginConfig = z.infer<typeof ConfigSchema>;

/**
 * An absent block yields the defaults.
 *
 * @throws {z.ZodError} on an invalid block, including a probability outside 0–1.
 */
export const parseAutoReplyConfig = (raw: unknown): AutoReplyPluginConfig =>
  ConfigSchema.parse(raw ?? {});
