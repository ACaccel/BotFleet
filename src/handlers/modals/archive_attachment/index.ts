import type { ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '../modal-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { archiveQueuedReply } from '../../commands/archive/presentation';

export default class archive_attachment extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply();
    try {
      const access = await requireArchiveAccess(interaction, bot);
      const values = ['channel_id', 'message_id', 'attachment_id'].map((key) =>
        interaction.fields.getTextInputValue(key).trim(),
      );
      if (values.some((value) => !/^\d{17,20}$/.test(value)))
        throw new ArchiveAccessError('replies:archive.invalid_input');
      const job = await access.control.submit('refresh-attachment', {
        channelId: values[0]!,
        messageId: values[1]!,
        attachmentId: values[2]!,
        userId: interaction.user.id,
        notification: { channelId: access.debugId },
      });
      await publishArchiveReply(
        interaction,
        archivePublicReply(archiveQueuedReply(job, bot), { jobId: job.jobId }),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
