import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalNumber, getRequiredNumber } from '../../../infra/discord/options';
import { fetchMee6Leaderboard, type Mee6Player } from '../mee6-shared/leaderboard';
import { formatLevelDetails, MAX_RANKS } from './format';

export default class level_detail extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'level_detail',
      category: 'stats',
      guildOnly: true,
      options: {
        integer: [
          { name: 'rank_from', required: true, min: 1, max: 1000 },
          { name: 'count', required: false, min: 1, max: MAX_RANKS },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:level_detail.${key}`, params) ?? '';
    try {
      const guildId = interaction.guildId;
      if (guildId === null) return;
      const rankFrom = getRequiredNumber(interaction, 'rank_from');
      const count = getOptionalNumber(interaction, 'count') ?? MAX_RANKS;

      let leaderboard: readonly Mee6Player[];
      try {
        leaderboard = await fetchMee6Leaderboard(guildId);
      } catch (error) {
        // Usually a private leaderboard or a changed MEE6 endpoint.
        logError(bot.logger, guildId, error);
        await interaction.editReply({ content: t('unavailable') });
        return;
      }

      const players = leaderboard.slice(rankFrom - 1, rankFrom - 1 + count);
      if (players.length === 0) {
        await interaction.editReply({ content: t('out_of_range', { total: leaderboard.length }) });
        return;
      }
      await interaction.editReply({
        content: formatLevelDetails(players, bot.translator),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:level_detail.failed',
        interaction.guildId,
      );
    }
  }
}
