import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveInputError } from '../../../core/errors';
import { requireArchiveAccess } from '../../commands/archive-shared/access';
import { archiveFailure } from '../../commands/archive-shared/failure';
import { parseArchivePanelId } from '../../../application/archive/panel-ids';
import { withArchivePublicMessageLock } from '../../../application/archive/public-message';
import { applyArchiveAction } from './actions';

/** `/archive` panel buttons; access is checked again on every press. */
export default class archive extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    try {
      const action = parseArchivePanelId(interaction.customId);
      if (action === undefined) throw new ArchiveInputError('replies:archive.navigation_stale');
      const access = await requireArchiveAccess(interaction, bot);
      await interaction.deferUpdate();
      await withArchivePublicMessageLock(
        interaction.channelId,
        interaction.message.id,
        async () => {
          const panel = await applyArchiveAction(interaction, bot, access, action);
          await interaction.editReply({ content: '', ...panel, allowedMentions: { parse: [] } });
        },
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
