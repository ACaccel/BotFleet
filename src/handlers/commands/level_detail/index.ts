import type { ChatInputCommandInteraction, User } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { bindTranslator, type BoundTranslate } from '../../../core/i18n';
import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalNumber } from '../../../infra/discord/options';
import { fetchMee6Leaderboard, type Mee6Player } from '../mee6-shared/leaderboard';
import { pageOfRank } from './format';
import { buildLeaderboardReply, buildMemberCard } from './view';

/**
 * The MEE6 leaderboard as a paged embed, or one member's level card.
 * `member` wins over `rank` when both are given, as `/help` documents.
 */
export default class level_detail extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'level_detail',
      category: 'stats',
      guildOnly: true,
      options: {
        integer: [{ name: 'rank', required: false, min: 1, max: 1000 }],
        user: [{ name: 'member', required: false }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    const t = bindTranslator(bot.translator);
    const answer = async (key: string, params?: Record<string, string | number>) =>
      interaction.editReply({
        content: t(`replies:level_detail.${key}`, params),
        allowedMentions: { parse: [] },
      });
    try {
      const guildId = interaction.guildId;
      if (guildId === null) return;

      let leaderboard: readonly Mee6Player[];
      try {
        leaderboard = await fetchMee6Leaderboard(guildId);
      } catch (error) {
        // Usually a private leaderboard or a changed MEE6 endpoint.
        logError(bot.logger, guildId, error);
        await answer('unavailable');
        return;
      }

      const user = interaction.options.getUser('member');
      if (user !== null) {
        await this.replyWithCard(interaction, leaderboard, user, t);
        return;
      }
      const rank = getOptionalNumber(interaction, 'rank');
      if (rank !== undefined && rank > leaderboard.length) {
        await answer('out_of_range', { total: leaderboard.length });
        return;
      }
      if (leaderboard.length === 0) {
        await answer('empty');
        return;
      }
      await interaction.editReply(
        buildLeaderboardReply(
          leaderboard,
          rank === undefined ? 1 : pageOfRank(rank),
          interaction.user.id,
          t,
          rank,
        ),
      );
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

  private async replyWithCard(
    interaction: ChatInputCommandInteraction,
    leaderboard: readonly Mee6Player[],
    user: User,
    t: BoundTranslate,
  ): Promise<void> {
    const index = leaderboard.findIndex((player) => player.id === user.id);
    if (index === -1) {
      await interaction.editReply({
        content: t('replies:level_detail.not_ranked', { member: `<@${user.id}>` }),
        allowedMentions: { parse: [] },
      });
      return;
    }
    // An uncached member resolves to raw API data without avatar helpers;
    // the user's own avatar is then current, unlike MEE6's stored copy.
    const resolved = interaction.options.getMember('member');
    const member = resolved !== null && 'displayAvatarURL' in resolved ? resolved : undefined;
    const card = buildMemberCard(leaderboard, index, t, {
      name: member?.displayName ?? user.displayName,
      avatarUrl: member?.displayAvatarURL() ?? user.displayAvatarURL(),
    });
    await interaction.editReply({ embeds: [card], allowedMentions: { parse: [] } });
  }
}
