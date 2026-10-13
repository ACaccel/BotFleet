import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class talk_signed extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'talk_signed',
      category: 'fun',
      guildOnly: true,
      options: {
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
      const content = getRequiredString(interaction, 'content');
      if (!content) {
        await interaction.reply({
          content: bot.translator?.t('replies:talk_signed.missing_args') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // check existance of channel and member
      const channel = interaction.channel;
      if (!channel?.isSendable()) {
        await interaction.reply({
          content: bot.translator?.t('errors:command.channel_not_sendable') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const guild_member =
        interaction.member && 'displayName' in interaction.member ? interaction.member : null;
      if (!guild_member) {
        await interaction.reply({
          content: bot.translator?.t('replies:talk_signed.member_not_found') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // avoid to tag everyone
      await interaction.deferReply();
      await interaction.deleteReply();
      if (content.includes('@everyone') || content.includes('@here')) {
        const tagMessage =
          bot.translator?.t('replies:talk_signed.tag_warning', {
            displayName: guild_member.displayName,
            username: interaction.user.username,
          }) ?? '';
        await channel.send({ content: tagMessage, allowedMentions: { parse: [] } });
      } else {
        await channel.send({
          content: `${guild_member.displayName}(${interaction.user.username}): ${content}`,
          allowedMentions: { parse: ['users', 'roles'] },
        });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:talk_signed.failed',
        interaction.guild?.id,
      );
    }
  }
}
