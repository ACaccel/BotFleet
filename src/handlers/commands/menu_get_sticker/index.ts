import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { MessageContextMenuCommandInteraction, ContextMenuCommandType } from 'discord.js';
import { EmbedBuilder, ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
export default class menu_get_sticker extends Command {
  constructor() {
    super();
    this.setConfig({
      // Stable ASCII id; the user-facing Discord name is resolved
      // from `commands:menu_get_sticker.name`.
      name: 'menu_get_sticker',
      category: 'utility',
      type: ApplicationCommandType.Message as ContextMenuCommandType,
    });
  }

  public override async execute(
    interaction: MessageContextMenuCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const message = interaction.targetMessage;
      const stickers = message.stickers;
      const content = message.content?.trim() || '';

      // Check for stickers first
      if (stickers.size > 0) {
        const embed = new EmbedBuilder().setTitle('Sticker URL').setColor(EMBED_COLORS.info);

        stickers.forEach((sticker) => {
          embed.addFields({
            name: sticker.name,
            value: sticker.url,
          });
        });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Check for single emoji in message content
      const emojiPattern = /^<a?:(\w+):(\d+)>$/;
      const emojiMatch = content.match(emojiPattern);

      if (emojiMatch) {
        const isAnimated = content.startsWith('<a:');
        const emojiName = emojiMatch[1] as string;
        const emojiId = emojiMatch[2] as string;
        const emojiUrl = isAnimated
          ? `https://cdn.discordapp.com/emojis/${emojiId}.gif`
          : `https://cdn.discordapp.com/emojis/${emojiId}.png`;

        const embed = new EmbedBuilder()
          .setTitle('Emoji URL')
          .setColor(EMBED_COLORS.info)
          .addFields({
            name: emojiName,
            value: emojiUrl,
          });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // No stickers or emoji found
      await interaction.editReply({
        content: bot.translator?.t('replies:menu_get_sticker.not_found') ?? '',
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:menu_get_sticker.failed',
        interaction.guild?.id,
      );
    }
  }
}
