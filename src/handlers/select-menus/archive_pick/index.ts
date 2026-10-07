import { resolveArchiveReference } from '../../commands/archive/manage-references';
import type { StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '../ssm-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { archiveManageJob, archiveManagePlan } from '../../commands/archive/manage-presentation';

export default class archive_pick extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferUpdate();
    try {
      const access = await requireArchiveAccess(interaction, bot);
      const id = interaction.values[0];
      if (
        bot.client.user === null ||
        interaction.message.author.id !== bot.client.user.id ||
        interaction.values.length !== 1 ||
        id === undefined ||
        !/^[A-Za-z0-9:_-]{1,160}$/.test(id) ||
        !['archive_pick|jobs', 'archive_pick|plans'].includes(interaction.customId)
      )
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const kind = interaction.customId === 'archive_pick|jobs' ? 'job' : 'plan';
      const target = id.startsWith('ref:')
        ? resolveArchiveReference(id.slice(4))
        : { action: kind, id };
      if (target.action !== kind) throw new ArchiveAccessError('replies:archive.navigation_stale');
      const actor = {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        messageId: interaction.message.id,
      };
      const reply =
        interaction.customId === 'archive_pick|jobs'
          ? await archiveManageJob(target.id, bot, access, actor)
          : await archiveManagePlan(target.id, bot, access, actor);
      await publishArchiveReply(interaction, reply, bot, access);
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
