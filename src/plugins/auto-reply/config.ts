/** Configuration schema and defaults for random DB-backed `[*]` replies. */
import { z } from 'zod';

const ConfigSchema = z
  .object({
    /** Chance that any eligible message triggers the DB-backed `[*]` lookup. */
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
