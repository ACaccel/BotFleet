import { type StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '../ssm-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveCategories, archiveManifestReply } from '../../commands/archive/presentation';
import { resolveArchiveNavigation } from '../../commands/archive/navigation';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';

export default class archive_category extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
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
      const { runId } = resolveArchiveNavigation(interaction.customId, actor, 'category');
      const value = interaction.values[0];
      const category = archiveCategories.find((entry) => entry === value);
      if (interaction.values.length !== 1 || (value !== 'all' && category === undefined))
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      await publishArchiveReply(
        interaction,
        archivePublicReply(
          await archiveManifestReply(runId, bot, control, actor, {
            view: 'changes',
            ...(category === undefined ? {} : { category }),
          }),
          { runId },
        ),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
