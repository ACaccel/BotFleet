import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import identity_config from './identity.json';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class change_avatar extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'change_avatar',
      category: 'admin',
      guildOnly: true,
      options: {
        string: [
          {
            name: 'identity',
            required: true,
            // The identity choices are the persona names
            // declared in the colocated `identity.json` data
            // file. Deriving them here keeps the choice
            // `name`/`value` CJK strings out of this `.ts`
            // source (the i18n scanner walks `.ts` only) and
            // keeps the JSON as the single source of truth.
            // The `value` stays the persona name because
            // `execute` matches it back against
            // `identity_config`.
            choices: identity_config.map((identity) => ({
              name: identity.name,
              value: identity.name,
            })),
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
      if (!identity_config) {
        await interaction.editReply({
          content: bot.translator?.t('replies:change_avatar.no_role_config') ?? '',
        });
        return;
      }

      // change nickname and avatar
      const newName = getRequiredString(interaction, 'identity');
      const oldName = bot.getGuildInfo(guild.id)?.bot_name;
      const userBot = guild.members.cache.get(bot.client.user?.id as string);
      if (!userBot) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.bot_not_found') ?? '',
        });
        return;
      }
      const new_identity = identity_config.find((e) => e.name === newName);
      if (!new_identity) {
        await interaction.editReply({
          content: bot.translator?.t('replies:change_avatar.new_role_not_found') ?? '',
        });
        return;
      }

      // change nickname and avatar (need to re-login the client)
      await userBot.setNickname(newName);
      await userBot.client.user.setAvatar(new_identity.avatar_url);
      await bot.reLogin();
      bot.updateBotName(guild.id, newName);

      const colorRole = userBot.roles.color;
      if (colorRole) {
        await userBot.roles.remove(colorRole);
      }

      const newColorRole = guild?.roles.cache.find((role) => role.name === new_identity.color_role);
      if (newColorRole) await userBot.roles.add(newColorRole);

      await interaction.editReply({
        content:
          bot.translator?.t('replies:change_avatar.changed', { oldName: oldName ?? '', newName }) ??
          '',
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:change_avatar.failed',
        interaction.guild?.id,
      );
    }
  }
}
