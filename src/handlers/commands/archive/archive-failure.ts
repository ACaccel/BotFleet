import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { z } from 'zod';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { ArchiveAccessError } from './access';
import { controlErrorKeys } from './control-error-keys';

export const archiveFailure = async (
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  bot: BaseBot,
  error: unknown,
): Promise<void> => {
  const key =
    error instanceof ArchiveAccessError
      ? error.key
      : error instanceof z.ZodError
        ? 'replies:archive.invalid_input'
        : error instanceof Error
          ? controlErrorKeys[error.message]
          : undefined;
  if (!interaction.deferred && !interaction.replied) {
    if (key === undefined)
      bot.logger?.error({ err: error }, 'Archive control failed before acknowledgement');
    await interaction.reply({
      content: bindTranslator(bot.translator)(key ?? 'replies:archive.failed'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (key !== undefined) {
    const content = bindTranslator(bot.translator)(key);
    if (
      'message' in interaction &&
      !('fields' in interaction) &&
      interaction.message !== null &&
      interaction.message.flags?.has(MessageFlags.Ephemeral) !== true
    ) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.deferred || interaction.replied)
      await interaction.editReply({ content, components: [], attachments: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  if (
    'message' in interaction &&
    !('fields' in interaction) &&
    interaction.message !== null &&
    interaction.message.flags?.has(MessageFlags.Ephemeral) !== true
  ) {
    bot.logger?.error(
      { err: error, guildId: interaction.guildId },
      'Archive public control failed',
    );
    await interaction.followUp({
      content: bindTranslator(bot.translator)('replies:archive.failed'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await replyForError(interaction, bot, error, 'replies:archive.failed', interaction.guildId);
};
