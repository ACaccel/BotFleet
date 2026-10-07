import { type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import {
  archiveConfirmationReference,
  archivePublicReply,
} from '../../commands/archive/public-reply';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { archiveJobReply, archiveQueuedReply } from '../../commands/archive/presentation';

export default class archive_confirm extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferUpdate();
    try {
      const match = /^archive_confirm\|([A-Za-z0-9_-]{24})$/.exec(interaction.customId);
      if (match?.[1] === undefined) throw new ArchiveAccessError('replies:archive.confirm_stale');
      const access = await requireArchiveAccess(interaction, bot);
      const { control } = access;
      await control.validateConfirmation(match[1], {
        userId: interaction.user.id,
        channelId: interaction.channelId,
      });
      const notification = await archiveConfirmationReference(
        access,
        match[1],
        interaction.user.id,
      );
      if (
        notification === undefined ||
        notification.messageId !== interaction.message.id ||
        bot.client.user === null ||
        interaction.message.author.id !== bot.client.user.id
      )
        throw new ArchiveAccessError('replies:archive.confirm_stale');
      const job = await control.confirm(
        match[1],
        { userId: interaction.user.id, channelId: interaction.channelId },
        (await archiveConfirmationReference(access, match[1], interaction.user.id, 'job')) ?? {
          channelId: access.debugId,
        },
      );
      await publishArchiveReply(
        interaction,
        archivePublicReply(
          job.status === 'queued'
            ? archiveQueuedReply(job, bot)
            : await archiveJobReply(job, bot, control, null),
          { jobId: job.jobId },
        ),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
