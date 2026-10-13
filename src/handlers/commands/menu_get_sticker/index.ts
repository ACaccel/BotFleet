import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { MessageContextMenuCommandInteraction, ContextMenuCommandType } from 'discord.js';
import { EmbedBuilder, ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { collectMedia, MAX_ITEMS } from './collect-media';

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
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:menu_get_sticker.${key}`, params) ?? '';
    try {
      const message = interaction.targetMessage;
      const items = collectMedia(message.stickers, message.content ?? '');
      if (items.length === 0) {
        await interaction.editReply({ content: t('not_found') });
        return;
      }

      const embeds = items.slice(0, MAX_ITEMS).map((item) => {
        const embed = new EmbedBuilder()
          .setTitle(t(`${item.kind}_title`, { name: item.name }))
          .setURL(item.url)
          .setColor(EMBED_COLORS.info);
        if (item.previewable) embed.setImage(item.url);
        else embed.setDescription(t('lottie_note'));
        return embed;
      });
      await interaction.editReply({
        content: items.length > MAX_ITEMS ? t('more_omitted', { count: MAX_ITEMS }) : undefined,
        embeds,
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:menu_get_sticker.failed',
        interaction.guildId,
      );
    }
  }
}
