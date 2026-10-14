/**
 * The ◀ / ▶ buttons under a `/db list` panel.
 *
 * Only the admin who ran the query may page; a rejection is private and the
 * panel stays as it was.
 */
import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { DbInspectError } from '../../../core/errors';
import { bindTranslator } from '../../../core/i18n';
import { dbInspectServiceFor } from '../../commands/db-shared/access';
import { decodeDbPageCustomId } from '../../commands/db-shared/custom-id';
import { dbFailure } from '../../commands/db-shared/failure';
import { buildListReply } from '../../commands/db-shared/list-view';
import { guildLabel } from '../../commands/db-shared/values';

export default class db_page extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const t = bindTranslator(bot.translator);
    try {
      const service = dbInspectServiceFor(bot, interaction.user.id);
      const target = decodeDbPageCustomId(interaction.customId);
      if (service === undefined || target === undefined) {
        throw new DbInspectError('DB_INSPECT_SESSION_EXPIRED');
      }
      service.assertSession(target.token, interaction.user.id);
      // The page query can outlast the three-second acknowledgement window.
      await interaction.deferUpdate();
      const page = await service.page(target.token, target.page, interaction.user.id);
      await interaction.editReply(
        buildListReply(page, guildLabel(interaction.client, page.database, t), t),
      );
    } catch (error) {
      await dbFailure(interaction, bot, error, { keepMessage: true });
    }
  }
}
