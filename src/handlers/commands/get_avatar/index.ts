import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class get_avatar extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'get_avatar',
      category: 'utility',
      options: {
        user: [
          {
            name: 'user',
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
      const user = getRequiredString(interaction, 'user');
      const member = interaction.guild?.members.cache.get(user);
      if (member) {
        let url = member.displayAvatarURL();
        url = url.replace('.webp', '.png?size=4096');

        const embed = new EmbedBuilder()
          .setTitle('User Avatar')
          .setAuthor({ name: member.user.tag, iconURL: url })
          .setImage(url)
          .setColor(EMBED_COLORS.info);

        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.user_not_found') ?? '',
        });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:get_avatar.failed',
        interaction.guild?.id,
      );
    }
  }
}
