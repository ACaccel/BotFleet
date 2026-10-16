import type { ChatInputCommandInteraction, GuildMember, Role } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { requireCapture } from '../../../core/regex-capture';
import { buildButtonRows } from '../discord-helpers';

import { canOfferRole, isSelfAssignableRole } from '../../../infra/discord/self-assignable-role';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class role_message extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'role_message',
      category: 'community',
      guildOnly: true,
      options: {
        string: [
          {
            name: 'roles',
            required: true,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.guild_not_found') ?? '',
        });
        return;
      }
      const member = interaction.member as GuildMember;
      if (!member.permissions.has('ManageRoles')) {
        await interaction.editReply({
          content: bot.translator?.t('replies:role_message.no_permission') ?? '',
        });
        return;
      }

      // Verify IDs format and existence
      const roles = getRequiredString(interaction, 'roles');
      if (!roles || !roles.match(/^<@&\d+>(\s*<@&\d+>)*$/)) {
        await interaction.editReply({
          content: bot.translator?.t('replies:role_message.format_error') ?? '',
        });
        return;
      }
      const roleIds = Array.from(roles.matchAll(/<@&(\d+)>/g)).map((match) =>
        requireCapture(match, 1),
      );
      const validRoles: Role[] = [];
      for (const roleId of roleIds) {
        const role = guild.roles.cache.get(roleId);
        if (!role) {
          await interaction.editReply({
            content: bot.translator?.t('replies:role_message.role_not_found', { id: roleId }) ?? '',
          });
          return;
        }
        if (!isSelfAssignableRole(role, guild.members.me) || !canOfferRole(role, member)) {
          await interaction.editReply({
            content:
              bot.translator?.t('replies:role_message.role_not_assignable', { id: roleId }) ?? '',
            allowedMentions: { parse: [] },
          });
          return;
        }
        validRoles.push(role);
      }
      if (validRoles.length === 0) {
        await interaction.editReply({
          content: bot.translator?.t('replies:role_message.no_valid_id') ?? '',
        });
        return;
      }

      // build buttons
      const button_config = validRoles.map((role) => ({
        customId: `toggle_role|${role.id}`,
        label: role.name,
      }));
      const rows = buildButtonRows(button_config);

      await interaction.editReply({
        content: bot.translator?.t('replies:role_message.prompt') ?? '',
        components: rows,
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:role_message.failed',
        interaction.guild?.id,
      );
    }
  }
}
