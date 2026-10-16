import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { checkIn, closeRollCall } from '../../../application/roll-call/roll-call';
import { canManageActivity } from '../../commands/activity-shared/authority';
import { buildRollCallDepsFromBot } from '../../commands/roll_call/deps-from-bot';

/** A roll call's buttons: called members check in; the caller or a manager closes it. */
export default class roll_call extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string): string => bot.translator?.t(`replies:roll_call.${key}`) ?? '';
    const guildId = interaction.guildId;
    if (guildId === null) return;
    const deps = buildRollCallDepsFromBot(bot);
    const messageId = interaction.message.id;

    if (interaction.customId.split('|')[1] === 'close') {
      const found = await bot.getRepos(guildId)?.rollCall.findByMessageId(messageId);
      if (found !== undefined && !found.ok) throw found.error;
      const doc = found?.value;
      if (!doc) {
        await interaction.editReply({ content: t('not_found') });
        return;
      }
      if (!canManageActivity(interaction, bot, doc.creator_id)) {
        await interaction.editReply({ content: t('close_forbidden') });
        return;
      }
      const closed = await closeRollCall(deps, guildId, messageId);
      await interaction.editReply({ content: t(closed ? 'closed' : 'already_closed') });
      return;
    }

    const outcome = await checkIn(deps, guildId, messageId, interaction.user.id);
    await interaction.editReply({ content: t(`check_in_${outcome}`) });
  }
}
