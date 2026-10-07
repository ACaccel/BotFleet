import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';

export const archiveAttachmentModal = (bot: BaseBot): ModalBuilder => {
  const t = bindTranslator(bot.translator);
  return new ModalBuilder()
    .setCustomId('archive_attachment')
    .setTitle(t('replies:archive.view_work_refresh-attachment').slice(0, 45))
    .addComponents(
      ...['channel_id', 'message_id', 'attachment_id'].map((field) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(field)
            .setLabel(t(`replies:archive.manage_${field}`))
            .setStyle(TextInputStyle.Short)
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true),
        ),
      ),
    );
};
