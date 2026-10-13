import type { ButtonInteraction, Guild, GuildMember } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { isSelfAssignableRole } from '../../../infra/discord/self-assignable-role';

export default class toggle_role extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const member = interaction.member as GuildMember;
    const guild = interaction.guild as Guild;
    const roleId = interaction.customId.split('|')[1] ?? '';
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.reply({
        content: bot.translator?.t('replies:toggle_role.role_not_found') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Recheck on every click: the role's permissions or position may have
    // changed since the panel was posted.
    if (!isSelfAssignableRole(role, guild.members.me)) {
      await interaction.reply({
        content: bot.translator?.t('replies:toggle_role.role_not_assignable') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // assign role or remove role
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
      await interaction.reply({
        content: bot.translator?.t('replies:toggle_role.removed', { role: role.name }) ?? '',
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await member.roles.add(roleId);
      await interaction.reply({
        content: bot.translator?.t('replies:toggle_role.added', { role: role.name }) ?? '',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
