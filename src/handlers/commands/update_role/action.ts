import { MessageFlags, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { fetchMee6Leaderboard } from '../mee6-shared/leaderboard';
import { parseUpdateRoleConfig } from './config';
import { resolveLevelRoles, syncLevelRoles } from './sync';

/** One sync per guild per ten minutes; each run edits roles across the guild. */
const COOLDOWN_MS = 10 * 60_000;
const lastRunByGuild = new Map<string, number>();

/** `/role sync`: give every ranked member the level role MEE6 says they have earned. */
export default class update_role extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'update_role', category: 'utility', guildOnly: true });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:update_role.${key}`, params) ?? '';
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: bot.translator?.t('errors:command.guild_not_found') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const config = parseUpdateRoleConfig(bot.config, (issue) =>
      logError(bot.logger, guild.id, issue),
    );
    if (config === undefined) {
      await interaction.reply({ content: t('no_config'), flags: MessageFlags.Ephemeral });
      return;
    }
    const now = Date.now();
    const readyAt = (lastRunByGuild.get(guild.id) ?? -Infinity) + COOLDOWN_MS;
    if (now < readyAt) {
      await interaction.reply({
        content: t('cooldown', {
          at: time(Math.ceil(readyAt / 1000), TimestampStyles.RelativeTime),
        }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    lastRunByGuild.set(guild.id, now);

    await interaction.deferReply();
    try {
      const players = await fetchMee6Leaderboard(guild.id).catch((error: unknown) => {
        logError(bot.logger, guild.id, error);
        return null;
      });
      if (players === null) {
        lastRunByGuild.delete(guild.id);
        await interaction.editReply({ content: t('unavailable') });
        return;
      }
      const levelRoles = resolveLevelRoles(guild, config.level_roles, bot.logger);
      const summary = await syncLevelRoles(guild, players, levelRoles, bot.logger);
      await interaction.editReply({ content: t('summary', { ...summary }) });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:update_role.failed', guild.id);
    }
  }
}
