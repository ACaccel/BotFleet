/**
 * Pure builder for the `/help` reply embed.
 *
 * Kept out of the handler `index.ts` so it can be unit-tested without a
 * Discord interaction: it takes the command map + translator and returns
 * an `EmbedBuilder`. The handler owns the Discord I/O (defer / editReply)
 * and error path; this module owns only the formatting.
 *
 * Imports come from `../command` (not the `@cmd` barrel) on purpose — the
 * barrel pulls in `registry.generated`, and `help/index.ts` is itself in
 * that registry; routing through the registry-free `command` module keeps
 * this helper out of that import cycle.
 */
import { EmbedBuilder } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { Command, CommandCategory } from '../command';
import { localizeCommandConfig } from '../command';

/** Discord brand blue — the repo's default embed colour. */
const HELP_EMBED_COLOR = 0x5865f2;

/** Discord's hard cap on a single embed field `value`. */
const FIELD_VALUE_MAX = 1024;

/**
 * Render order for category sections. `'other'` is last so unclassified
 * commands fall to the end as a catch-all.
 */
const CATEGORY_ORDER: readonly CommandCategory[] = [
  'auto_reply',
  'fun',
  'server_activity',
  'utility',
  'admin',
  'ai',
  'other',
];

interface HelpEmbedOptions {
  /** Display name shown in the embed author line. */
  readonly botName: string;
  /** Optional avatar URL for the embed author icon. */
  readonly botAvatarUrl?: string;
  /** Personality intro (from `bot.helpMessage`); empty falls back to a generic line. */
  readonly intro: string;
}

/** Truncate to `max` chars, appending an ellipsis when cut. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Build the categorized `/help` embed from a bot's loaded command
 * handlers. Commands are grouped by `config.category` (defaulting to
 * `'other'`), each non-empty category becomes one embed field, and the
 * footer carries the command / category counts.
 */
export const buildHelpEmbed = (
  commandHandlers: Map<string, Command>,
  translator: Translator | undefined,
  options: HelpEmbedOptions,
): EmbedBuilder => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translator?.t(key, params) ?? '';

  // Group localized command lines by category, preserving the handler
  // registration order within each group.
  const grouped = new Map<CommandCategory, string[]>();
  for (const cmd of commandHandlers.values()) {
    if (cmd.config.name.length === 0) continue;
    const category = cmd.config.category ?? 'other';
    const localized = localizeCommandConfig(cmd.config, translator);
    const paths = [
      ...(localized.subcommands ?? []).map((entry) => `/${localized.name} ${entry.name}`),
      ...(localized.subcommandGroups ?? []).flatMap((group) =>
        group.subcommands.map((entry) => `/${localized.name} ${group.name} ${entry.name}`),
      ),
    ];
    // Show executable paths while retaining one entry per registered command.
    const label =
      localized.type !== undefined
        ? `\`${localized.name}\``
        : (paths.length ? paths : [`/${localized.name}`]).map((name) => `\`${name}\``).join(', ');
    const line = `${label} ${localized.description}`.trimEnd();
    const bucket = grouped.get(category);
    if (bucket !== undefined) bucket.push(line);
    else grouped.set(category, [line]);
  }

  const authorName = `${options.botName} · ${t('replies:help.title')}`;
  const embed = new EmbedBuilder()
    .setColor(HELP_EMBED_COLOR)
    .setAuthor(
      options.botAvatarUrl !== undefined
        ? { name: authorName, iconURL: options.botAvatarUrl }
        : { name: authorName },
    );

  const intro = options.intro.trim();
  embed.setDescription(intro.length > 0 ? intro : t('replies:help.intro_fallback'));

  let commandCount = 0;
  let categoryCount = 0;
  for (const category of CATEGORY_ORDER) {
    const lines = grouped.get(category);
    if (lines === undefined || lines.length === 0) continue;
    categoryCount += 1;
    commandCount += lines.length;
    embed.addFields({
      name: t(`replies:help.category.${category}`),
      value: truncate(lines.join('\n'), FIELD_VALUE_MAX),
    });
  }

  embed.setFooter({
    text: t('replies:help.footer', { count: commandCount, categories: categoryCount }),
  });
  return embed;
};
