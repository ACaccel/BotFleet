import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import {
  findPersona,
  isAvatarRateLimit,
  PERSONAS,
  readPersonaAvatar,
  swapColorRole,
} from './persona';

export default class change_avatar extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'change_avatar',
      category: 'fun',
      guildOnly: true,
      options: {
        string: [
          {
            name: 'identity',
            required: true,
            // Persona names come from the colocated `identity.json`, which
            // keeps the CJK choice labels out of this source file.
            choices: PERSONAS.map((persona) => ({ name: persona.name, value: persona.name })),
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
    const t = (key: string, params?: Record<string, string>): string =>
      bot.translator?.t(key, params) ?? '';
    try {
      const guild = interaction.guild;
      const me = guild?.members.me;
      if (!guild || !me) {
        await interaction.editReply({ content: t('errors:command.bot_not_found') });
        return;
      }
      const persona = findPersona(getRequiredString(interaction, 'identity'));
      if (!persona) {
        await interaction.editReply({ content: t('replies:change_avatar.new_role_not_found') });
        return;
      }
      const avatar = await readPersonaAvatar(persona);
      if (avatar === null) {
        await interaction.editReply({ content: t('replies:change_avatar.avatar_missing') });
        return;
      }

      // The avatar is account-wide and rate-limited, so change it first:
      // when Discord refuses, nothing else has changed yet.
      try {
        await me.client.user.setAvatar(avatar);
      } catch (error) {
        if (!isAvatarRateLimit(error)) throw error;
        logError(bot.logger, guild.id, error);
        await interaction.editReply({ content: t('replies:change_avatar.rate_limited') });
        return;
      }
      const oldName = bot.getGuildInfo(guild.id)?.bot_name ?? '';
      await me.setNickname(persona.name);
      bot.updateBotName(guild.id, persona.name);
      await swapColorRole(me, persona);

      await interaction.editReply({
        content: t('replies:change_avatar.changed', { oldName, newName: persona.name }),
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:change_avatar.failed',
        interaction.guildId,
      );
    }
  }
}
