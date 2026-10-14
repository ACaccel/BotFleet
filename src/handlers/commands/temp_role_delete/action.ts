import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { cancelTempRole } from '../../../application/temp-role/temp-role';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import { buildTempRoleDepsFromBot } from '../temp_role/deps-from-bot';

/** `/role temp delete`: end a temp role early; its creator or a role manager may. */
export default class temp_role_delete extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'temp_role_delete',
      category: 'utility',
      guildOnly: true,
      options: { role: [{ name: 'role', required: true }] },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string): string => bot.translator?.t(`replies:temp_role.${key}`) ?? '';
    try {
      const guildId = interaction.guildId;
      if (guildId === null) return;
      const outcome = await cancelTempRole(
        buildTempRoleDepsFromBot(bot),
        guildId,
        getRequiredString(interaction, 'role'),
        (creatorId) =>
          creatorId === interaction.user.id ||
          bot.isAdmin(interaction.user.id) ||
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) === true,
      );
      if (outcome.status === 'no_db') {
        await interaction.editReply({ content: bot.translator?.t('errors:db.not_found') ?? '' });
        return;
      }
      const key = {
        cancelled: 'cancelled',
        not_temp_role: 'not_temp_role',
        forbidden: 'cancel_forbidden',
      };
      await interaction.editReply({ content: t(key[outcome.status]) });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:temp_role.failed', interaction.guildId);
    }
  }
}
