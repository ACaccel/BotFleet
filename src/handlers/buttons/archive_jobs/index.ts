import { ARCHIVE_LIST_PAGE_SIZE } from '../../commands/archive/jobs-presentation';
import { type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveJobsReply } from '../../commands/archive/presentation';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';

export default class archive_jobs extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferUpdate();
    try {
      const match = /^archive_jobs\|(all|active)\|([A-Za-z0-9:_-]{1,160})$/.exec(
        interaction.customId,
      );
      if (match?.[2] === undefined)
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const access = await requireArchiveAccess(interaction, bot);
      const { control } = access;
      const all = match[1] === 'all';
      await publishArchiveReply(
        interaction,
        archiveJobsReply(
          await control.jobs({ all, before: match[2], limit: ARCHIVE_LIST_PAGE_SIZE }),
          bot,
          all,
        ),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
