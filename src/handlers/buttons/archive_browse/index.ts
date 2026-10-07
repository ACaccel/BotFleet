import { PermissionFlagsBits, type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveManifestReply } from '../../commands/archive/presentation';
import { resolveArchiveNavigation } from '../../commands/archive/navigation';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';

export default class archive_browse extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferUpdate();
    try {
      const access = await requireArchiveAccess(interaction, bot);
      const { control } = access;
      const actor = {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId!,
        messageId: interaction.message.id,
      };
      const navigation = resolveArchiveNavigation(interaction.customId, actor);
      if (
        navigation.page.view === 'download' &&
        interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles) === false
      )
        throw new ArchiveAccessError('commands:archive_ui.download_permission');
      await publishArchiveReply(
        interaction,
        archivePublicReply(
          await archiveManifestReply(navigation.runId, bot, control, actor, navigation.page),
          { runId: navigation.runId },
        ),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
