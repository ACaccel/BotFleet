import type { ChatInputCommandInteraction } from 'discord.js';
import Mee6LevelsApi from 'mee6-levels-api';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredNumber } from '../../../infra/discord/options';
export default class level_detail extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'level_detail',
      category: 'utility',
      guildOnly: true,
      options: {
        integer: [
          {
            name: 'left',
            required: true,
          },
          {
            name: 'right',
            required: true,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const left = getRequiredNumber(interaction, 'left');
      const right = getRequiredNumber(interaction, 'right');
      const rangeSize = right - left;

      if (rangeSize <= 10) {
        let content = '';
        const leaderboard = await Mee6LevelsApi.getLeaderboardPage(interaction.guild?.id as string);

        leaderboard.slice(left - 1, right).forEach((e) => {
          const averageXp = (e.xp.totalXp / e.messageCount).toPrecision(6);
          content += `> **${e.rank} - ${e.username}﹝Level ${e.level}﹞**\n`;
          content +=
            bot.translator?.t('replies:level_detail.message_count', { count: e.messageCount }) ??
            '';
          content +=
            bot.translator?.t('replies:level_detail.current_xp', {
              userXp: e.xp.userXp,
              levelXp: e.xp.levelXp,
            }) ?? '';
          content +=
            bot.translator?.t('replies:level_detail.total_xp', { totalXp: e.xp.totalXp }) ?? '';
          content += bot.translator?.t('replies:level_detail.average_xp', { averageXp }) ?? '';
        });

        if (content.length < 2000) {
          await interaction.editReply({ content });
        } else {
          await interaction.editReply({
            content: bot.translator?.t('replies:level_detail.too_long') ?? '',
          });
        }
      } else {
        await interaction.editReply({
          content: bot.translator?.t('replies:level_detail.too_long') ?? '',
        });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:level_detail.failed',
        interaction.guild?.id,
      );
    }
  }
}
