import type { ChatInputCommandInteraction } from 'discord.js';
import Mee6LevelsApi from 'mee6-levels-api';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { parseUpdateRoleConfig } from './config';

// only for Nijika
export default class update_role extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'update_role',
      category: 'admin',
      guildOnly: true,
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const botConfig = parseUpdateRoleConfig(bot.config, (issue) => {
        // Present but invalid is an operator mistake, not an
        // opt-out; the user-facing reply cannot tell them apart.
        logError(bot.logger, interaction.guild?.id, issue);
      });
      if (botConfig === undefined) {
        await interaction.editReply({
          content: bot.translator?.t('replies:update_role.no_config') ?? '',
        });
        return;
      }

      const guildId = interaction.guild?.id;
      if (guildId === undefined) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.guild_not_found') ?? '',
        });
        return;
      }
      // A guild the bot never registered has no cached role list to
      // reconcile against; the non-null assertion this replaces
      // crashed on every unregistered guild.
      const guildInfo = bot.getGuildInfo(guildId);
      if (guildInfo === undefined) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.guild_not_found') ?? '',
        });
        return;
      }

      const leaderboard = await Mee6LevelsApi.getLeaderboardPage(guildId);
      const guild = guildInfo.guild;
      const channel = interaction.channel;
      if (!channel?.isSendable()) return;

      await Promise.all(
        leaderboard.map(async (member) => {
          const { id, level } = member;
          const guildMember = guild.members.cache.get(id);

          if (!guildMember) return;

          // find corresponding role
          let roleToAssign = '';
          for (const roleLevel in botConfig.level_roles) {
            if (level >= parseInt(roleLevel.split('_')[1] ?? '0')) {
              roleToAssign = botConfig.level_roles[roleLevel] ?? '';
            } else {
              break;
            }
          }
          if (roleToAssign === '') return;

          const addedRole = guild.roles.cache.find((role) => role.name === roleToAssign);
          const hasRoleToAssign = guildMember.roles.cache.has(addedRole?.id as string);
          for (const roleLevel in botConfig.level_roles) {
            const removedRole = guild.roles.cache.find(
              (role) => role.name === botConfig.level_roles[roleLevel],
            );
            if (!removedRole) continue;

            if (guildMember.roles.cache.has(removedRole.id) && removedRole.name !== roleToAssign) {
              await guildMember.roles.remove(removedRole);
              await channel.send(
                bot.translator?.t('replies:update_role.removed', {
                  name: guildMember.user.displayName,
                  role: botConfig.level_roles[roleLevel] ?? '',
                }) ?? '',
              );
            }
          }
          if (addedRole && !hasRoleToAssign) {
            await guildMember.roles.add(addedRole);
            await channel.send(
              bot.translator?.t('replies:update_role.granted', {
                name: guildMember.user.displayName,
                role: roleToAssign,
              }) ?? '',
            );
          }
        }),
      );
      await interaction.editReply({ content: bot.translator?.t('replies:update_role.done') ?? '' });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:update_role.failed',
        interaction.guild?.id,
      );
    }
  }
}
