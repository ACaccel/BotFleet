import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { dispatchArchiveManagement } from '../../commands/archive/manage-dispatch';
import { archiveAttachmentModal } from '../../commands/archive/attachment-modal';
import { resolveArchiveReference } from '../../commands/archive/manage-references';

export default class archive_manage extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const modal = interaction.customId === 'archive_manage|attachment|guild';
    if (!modal) await interaction.deferUpdate();
    try {
      const access = await requireArchiveAccess(interaction, bot);
      if (bot.client.user === null || interaction.message.author.id !== bot.client.user.id)
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      if (modal) {
        await interaction.showModal(archiveAttachmentModal(bot));
        return;
      }
      const match = /^archive_manage\|([a-z-]+)\|([A-Za-z0-9:_-]{1,160})$/.exec(
        interaction.customId,
      );
      if (match?.[1] === undefined || match[2] === undefined)
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const target =
        match[1] === 'ref' ? resolveArchiveReference(match[2]) : { action: match[1], id: match[2] };
      await publishArchiveReply(
        interaction,
        await dispatchArchiveManagement(target.action, target.id, interaction, bot, access),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
