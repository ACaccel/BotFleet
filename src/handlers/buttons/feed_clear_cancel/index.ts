/**
 * Abandons the whole-channel clear `/feed unsubscribe` proposed.
 *
 * The safe half of the prompt: it touches no repository, so there is
 * nothing to gate beyond replacing the prompt with a plain statement
 * that nothing changed. `update` rather than a fresh reply, so the
 * warning does not linger above its own answer.
 */
import type { ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { decodeFeedClearCustomId } from '../../feed-clear-custom-id';

export default class feed_clear_cancel extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    // Falls back to the key, never to '', which Discord rejects.
    const t = bindTranslator(bot.translator);
    try {
      const scope = decodeFeedClearCustomId(interaction.customId);
      if (scope === undefined) {
        // Symmetric with the confirm button: an id this build cannot
        // read belongs to a prompt that can no longer be answered.
        await interaction.update({ content: t('replies:feed.clear_stale'), components: [] });
        return;
      }
      if (scope.invokerId !== interaction.user.id) {
        // Only the member who was asked may answer, and the prompt
        // survives until they do.
        await interaction.reply({
          content: t('replies:feed.clear_not_invoker'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.update({ content: t('replies:feed.clear_cancelled'), components: [] });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:feed.failed', interaction.guildId);
    }
  }
}
