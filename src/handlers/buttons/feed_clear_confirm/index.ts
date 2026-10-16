/**
 * Confirms clearing every feed subscription in one channel — the
 * destructive half of the prompt `/feed unsubscribe` shows when a
 * member names neither a platform nor an account.
 *
 * The button is where the deletion actually happens, so it re-derives
 * everything the command established rather than trusting the customId:
 * the guild's repositories, and the invoker's `ViewChannel` on the
 * target. A customId is a public value, and the gap between prompt and
 * click is long enough for a permission to be revoked in.
 *
 * The invoker check is defence in depth. The prompt is ephemeral, so
 * nobody else can see the button, let alone press it; the check costs
 * one comparison and removes the need to reason about that guarantee.
 */
import type { ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { bindTranslator } from '../../../core/i18n';
import { logSystem, ops } from '../../../core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { gateFeedChannel } from '../../feed-channel-gate';
import { decodeFeedClearCustomId } from '../../feed-clear-custom-id';
import { formatRemovedForLog, formatRemovedForReply } from '../../feed-removed-list';
import { requireGuildRepos } from '../../require-guild-repos';

export default class feed_clear_confirm extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    // Falls back to the key, never to '', which Discord rejects.
    const t = bindTranslator(bot.translator);
    try {
      const scope = decodeFeedClearCustomId(interaction.customId);
      if (scope === undefined) {
        // An id from an older deployment names no channel, and guessing
        // one would be the worst possible recovery. Retire the prompt
        // rather than leave a button that can never work.
        await interaction.update({ content: t('replies:feed.clear_stale'), components: [] });
        return;
      }
      if (scope.invokerId !== interaction.user.id) {
        // Answered separately so the prompt itself survives: whoever
        // owns it has not decided yet.
        await interaction.reply({
          content: t('replies:feed.clear_not_invoker'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Acknowledge and disarm in one request. A database read, a delete
      // and a rendered reply do not reliably fit inside Discord's
      // three-second window, and taking the buttons away at
      // acknowledgement time means no later failure can leave them live.
      await interaction.update({ components: [] });

      const guild = interaction.guild;
      const repos = await requireGuildRepos(bot, interaction);
      // Already replied on null; the `guild` half restates that for tsc.
      if (repos === null || guild === null) return;

      const gate = gateFeedChannel(guild, scope.channelId, interaction.user.id);
      if (gate.kind === 'refused') {
        // The member passed this same gate when the prompt was built, so
        // a refusal here means something changed in between.
        logSystem(bot.logger, ops.feed.clearDenied(scope.channelId, gate.reason));
        await interaction.editReply({ content: t(gate.key, gate.params) });
        return;
      }

      // Addressed by the channel the gate admitted, not by the raw
      // decoded id: the same value, but the delete cannot outrun what
      // was actually checked.
      const channelId = gate.channel.id;
      const deleted = await repos.feedSubscription.deleteWhere({ channelId });
      if (!deleted.ok) throw deleted.error;
      const removed = deleted.value;

      if (removed.length === 0) {
        // Someone else cleared the channel between the prompt and the
        // click. Nothing was lost, so say what is true now.
        await interaction.editReply({
          content: t('replies:feed.unsubscribed_none', { channel: gate.mention }),
        });
        return;
      }

      // Logged before the reply: the deletion has already committed, and
      // the confirmation is both bounded and losable.
      logSystem(
        bot.logger,
        ops.feed.subscriptionsRemoved(channelId, removed.length, formatRemovedForLog(removed)),
      );
      await interaction.editReply({
        content: t('replies:feed.unsubscribed', {
          count: removed.length,
          list: formatRemovedForReply(removed, t),
        }),
      });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:feed.failed', interaction.guildId);
    }
  }
}
