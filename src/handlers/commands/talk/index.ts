import type { ChatInputCommandInteraction, Guild } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class talk extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'talk',
      category: 'fun',
      options: {
        channel: [
          {
            name: 'channel',
            required: true,
          },
        ],
        string: [
          {
            name: 'content',
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
    try {
      // Unsigned speech is untraceable to members, so only bot admins may use it.
      if (!bot.isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: bot.translator?.t('errors:permission.admin_only_short') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const ch = getRequiredString(interaction, 'channel');
      const content = getRequiredString(interaction, 'content');
      if (!ch || !content) {
        await interaction.reply({
          content: bot.translator?.t('replies:talk.missing_args') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // check existance of channel
      const guild = interaction.guild as Guild;
      const channel = guild.channels.cache.get(ch);
      if (!channel?.isSendable()) {
        await interaction.reply({
          content: bot.translator?.t('errors:command.channel_not_sendable') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // avoid to tag everyone
      await interaction.deferReply();
      await interaction.deleteReply();
      if (content.includes('@everyone') || content.includes('@here')) {
        const tagMessage =
          bot.translator?.t('replies:talk.tag_warning', { user: interaction.user.username }) ?? '';
        await channel.send({ content: tagMessage, allowedMentions: { parse: [] } });
      } else {
        await channel.send({ content, allowedMentions: { parse: ['users', 'roles'] } });
      }
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:talk.failed', interaction.guild?.id);
    }
  }
}
