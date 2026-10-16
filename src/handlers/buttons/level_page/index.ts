/**
 * The ◀ / ▶ buttons under a `/level_detail` leaderboard.
 *
 * Only the member who ran the command may page, so a busy channel
 * cannot fight over one message. Each press re-reads the cached
 * leaderboard and clamps the page, which covers a board that shrank
 * since the message was posted.
 */
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { bindTranslator } from '../../../core/i18n';
import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { decodeLevelPageCustomId } from '../../commands/level_detail/custom-id';
import { buildLeaderboardReply } from '../../commands/level_detail/view';
import { fetchMee6Leaderboard, type Mee6Player } from '../../commands/mee6-shared/leaderboard';

export default class level_page extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const t = bindTranslator(bot.translator);
    const refuse = async (key: string): Promise<void> => {
      await interaction.reply({
        content: t(`replies:level_detail.${key}`),
        flags: MessageFlags.Ephemeral,
      });
    };
    try {
      const target = decodeLevelPageCustomId(interaction.customId);
      const guildId = interaction.guildId;
      if (target === undefined || guildId === null) {
        await refuse('stale');
        return;
      }
      if (target.invokerId !== interaction.user.id) {
        // Refused privately, leaving the shared leaderboard untouched.
        await refuse('not_invoker');
        return;
      }
      // A cold cache means a MEE6 request, which can outlast the
      // three-second acknowledgement window.
      await interaction.deferUpdate();

      let leaderboard: readonly Mee6Player[];
      try {
        leaderboard = await fetchMee6Leaderboard(guildId);
      } catch (error) {
        logError(bot.logger, guildId, error);
        // The page already shown stays; only the presser learns why it did not turn.
        await interaction.followUp({
          content: t('replies:level_detail.unavailable'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (leaderboard.length === 0) {
        await interaction.editReply({
          content: t('replies:level_detail.empty'),
          embeds: [],
          components: [],
        });
        return;
      }
      await interaction.editReply(
        buildLeaderboardReply(leaderboard, target.page, target.invokerId, t),
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
}
