/**
 * Builders for the `/help` views: the overview with its category menu,
 * one category's executable paths, and one command's detail page.
 *
 * Pure apart from discord.js builders, so they are unit-tested without an
 * interaction; the handler and the category menu own the Discord I/O.
 * Imports avoid the `@cmd` barrel, which registers `/help` itself.
 */
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import { EmbedBuilder, type ActionRowBuilder, type StringSelectMenuBuilder } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { Command, CommandCategory } from '../command';
import { buildCategoryMenu } from './category-menu';
import { commandsByCategory, helpPaths, type HelpPath } from './help-model';
import {
  FIELD_MAX,
  displayName,
  isMenu,
  packLines,
  pathLabel,
  summary,
  translate,
  truncate,
} from './help-presentation';

/** Discord's caps on embed descriptions and field count. */
const DESCRIPTION_MAX = 4096;
const MAX_FIELDS = 25;

interface HelpViewer {
  /** Bot admins also see admin-only paths. */
  readonly isAdmin: boolean;
}

interface OverviewOptions extends HelpViewer {
  /** Display name shown in the embed author line. */
  readonly botName: string;
  readonly botAvatarUrl?: string;
  /** Personality intro (from `bot.helpMessage`); empty falls back to a generic line. */
  readonly intro: string;
}

const visiblePaths = (command: Command, viewer: HelpViewer): HelpPath[] =>
  helpPaths(command).filter((path) => viewer.isAdmin || !path.adminOnly);

/** The ephemeral overview: one line per command, grouped, plus the category menu. */
export const buildHelpOverview = (
  handlers: ReadonlyMap<string, Command>,
  translator: Translator | undefined,
  options: OverviewOptions,
): { embed: EmbedBuilder; menu: ActionRowBuilder<StringSelectMenuBuilder> | null } => {
  const t = translate(translator);
  const authorName = `${options.botName} · ${t('replies:help.title')}`;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setAuthor(
      options.botAvatarUrl !== undefined
        ? { name: authorName, iconURL: options.botAvatarUrl }
        : { name: authorName },
    );
  const intro = options.intro.trim() || t('replies:help.intro_fallback');
  embed.setDescription(truncate(`${intro}\n\n${t('replies:help.usage_hint')}`, DESCRIPTION_MAX));

  const categories: CommandCategory[] = [];
  let commandCount = 0;
  for (const [category, commands] of commandsByCategory(handlers)) {
    const lines = commands
      .filter((command) => visiblePaths(command, options).length > 0)
      .map((command) => `\`${displayName(command, t)}\` ${summary(command, t)}`);
    if (lines.length === 0) continue;
    categories.push(category);
    commandCount += lines.length;
    for (const value of packLines(lines)) {
      if ((embed.data.fields?.length ?? 0) >= MAX_FIELDS) break;
      embed.addFields({ name: t(`replies:help.category.${category}`), value });
    }
  }
  embed.setFooter({ text: t('replies:help.footer', { count: commandCount }) });

  return { embed, menu: categories.length === 0 ? null : buildCategoryMenu(categories, t) };
};

/** Every executable path in one category, each with its own description. */
export const buildCategoryEmbed = (
  handlers: ReadonlyMap<string, Command>,
  translator: Translator | undefined,
  category: CommandCategory,
  viewer: HelpViewer,
): EmbedBuilder => {
  const t = translate(translator);
  const commands = commandsByCategory(handlers).get(category) ?? [];
  const lines = commands.flatMap((command) =>
    visiblePaths(command, viewer).map((path) => {
      const description = path.descriptionKey ? t(path.descriptionKey) : summary(command, t);
      return `**\`${pathLabel(path, t)}\`** ${description}`;
    }),
  );
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t(`replies:help.category.${category}`))
    .setDescription(truncate(lines.join('\n') || t('replies:help.category_empty'), DESCRIPTION_MAX))
    .setFooter({ text: t('replies:help.detail_hint') });
};

/** One command's detail page: its purpose, notes, and every path with its options. */
export const buildCommandDetail = (
  command: Command,
  translator: Translator | undefined,
  viewer: HelpViewer,
): EmbedBuilder => {
  const t = translate(translator);
  const details = t(`replies:help.details.${command.config.name}`);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(displayName(command, t))
    .setDescription(truncate(`${summary(command, t)}\n\n${details}`, DESCRIPTION_MAX));
  for (const path of visiblePaths(command, viewer).slice(0, MAX_FIELDS)) {
    if (isMenu(command)) break;
    const optionLines = path.options.map(
      (option) =>
        `• \`${option.name}\` (${t(option.required ? 'replies:help.required' : 'replies:help.optional')}) ${t(option.descriptionKey)}`,
    );
    const lines = [
      t(path.descriptionKey),
      ...(path.adminOnly ? [t('replies:help.admin_only')] : []),
      ...optionLines,
    ];
    embed.addFields({ name: pathLabel(path, t), value: truncate(lines.join('\n'), FIELD_MAX) });
  }
  return embed;
};
