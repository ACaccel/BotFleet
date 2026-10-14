/**
 * The `bug_report` block of a bot's `config.json`: the hub forum that
 * receives every ticket, and optionally the names of its forum tags.
 * Tag names are operator data, so localized names stay out of source.
 */
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

const TAG_KEYS = ['bug', 'suggestion', 'other', 'open', 'in_progress', 'closed'] as const;
export type BugTagKey = (typeof TAG_KEYS)[number];

const BlockSchema = z
  .object({
    hub: z.object({ guildId: snowflake, channelId: snowflake }).strict(),
    tags: z
      .object(Object.fromEntries(TAG_KEYS.map((key) => [key, z.string().min(1).optional()])))
      .strict()
      .optional(),
  })
  .strict();

const ConfigSchema = z.object({ bug_report: BlockSchema.optional() }).passthrough();

export interface BugReportConfig {
  readonly hub: { readonly guildId: string; readonly channelId: string };
  readonly tags: Partial<Record<BugTagKey, string>>;
}

/** The block, `undefined` when absent; throws when present but malformed. */
export const readBugReportConfig = (botConfig: unknown): BugReportConfig | undefined => {
  const block = ConfigSchema.parse(botConfig ?? {}).bug_report;
  return block === undefined
    ? undefined
    : { hub: block.hub, tags: (block.tags ?? {}) as Partial<Record<BugTagKey, string>> };
};

/** The block, required: `/bug_report` cannot work without a hub. */
export const parseBugReportConfig = (botConfig: unknown): BugReportConfig => {
  const config = readBugReportConfig(botConfig);
  if (config === undefined)
    throw new Error('bug_report.hub is required when /bug_report is enabled');
  return config;
};
