import { type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveCategories, archiveManifestReply } from '../../commands/archive/presentation';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';

export default class archive_view extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    // A forged navigation button on a public message must never edit that message with private data.
    await interaction.deferUpdate();
    try {
      const match =
        /^archive_view\|([A-Za-z0-9:_-]{1,160})\|([sct])\|([anp])\|(-1|\d{1,16})\|(a|[0-6])$/.exec(
          interaction.customId,
        );
      if (match === null) throw new ArchiveAccessError('replies:archive.navigation_stale');
      const [, runId, view, direction, sequenceText, categoryText] = match;
      const sequence = Number(sequenceText);
      if (
        runId === undefined ||
        !Number.isSafeInteger(sequence) ||
        (direction !== 'a' && sequence < 0)
      )
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const access = await requireArchiveAccess(interaction, bot);
      const { control } = access;
      await publishArchiveReply(
        interaction,
        archivePublicReply(
          await archiveManifestReply(
            runId,
            bot,
            control,
            { userId: interaction.user.id, channelId: interaction.channelId },
            {
              view: view === 's' ? 'summary' : view === 'c' ? 'changes' : 'technical',
              ...(direction === 'a'
                ? {}
                : direction === 'p'
                  ? { beforeSequence: sequence }
                  : { afterSequence: sequence }),
              ...(categoryText === 'a'
                ? {}
                : { category: archiveCategories[Number(categoryText)] }),
              limit: 5,
            },
          ),
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
