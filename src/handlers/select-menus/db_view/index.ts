/**
 * The "view details" menu under a `/db list` panel: shows the chosen row's
 * full document in a new ephemeral reply, leaving the panel in place.
 */
import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '@select-menu';

import { DbInspectError } from '../../../core/errors';
import { bindTranslator } from '../../../core/i18n';
import { dbInspectServiceFor } from '../../commands/db-shared/access';
import { decodeDbViewCustomId } from '../../commands/db-shared/custom-id';
import { dbFailure } from '../../commands/db-shared/failure';
import { buildDocumentReply } from '../../commands/db-shared/document-view';
import { guildLabel } from '../../commands/db-shared/values';

export default class db_view extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = bindTranslator(bot.translator);
    try {
      const service = dbInspectServiceFor(bot, interaction.user.id);
      const token = decodeDbViewCustomId(interaction.customId);
      const index = Number(interaction.values[0]);
      if (service === undefined || token === undefined || !Number.isInteger(index)) {
        throw new DbInspectError('DB_INSPECT_SESSION_EXPIRED');
      }
      service.assertSession(token, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const view = await service.documentAt(token, index, interaction.user.id);
      await interaction.editReply(
        buildDocumentReply(view, guildLabel(interaction.client, view.database, t), t),
      );
    } catch (error) {
      await dbFailure(interaction, bot, error);
    }
  }
}
