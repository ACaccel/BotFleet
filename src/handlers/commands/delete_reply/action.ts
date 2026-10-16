import type { ChatInputCommandInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import { canDeleteReply } from '../reply-shared/authority';

/** Discord allows 25 options per select and five selects per message. */
const OPTIONS_PER_SELECT = 25;
const MAX_SELECTS = 5;

export default class delete_reply extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'delete_reply',
      category: 'community',
      options: { string: [{ name: 'keyword', required: true, maxLength: 100 }] },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:delete_reply.${key}`, params) ?? '';
    try {
      const key = getRequiredString(interaction, 'keyword');
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      // A repo `err` is re-thrown into the surrounding catch.
      const pairsResult = await repos.reply.findByInput(key);
      if (!pairsResult.ok) throw pairsResult.error;
      const pairs = pairsResult.value;
      if (pairs.length === 0) {
        await interaction.editReply({ content: t('not_found', { keyword: key }) });
        return;
      }
      const deletable = pairs
        .filter((pair) => canDeleteReply(interaction, bot, pair.created_by))
        .slice(0, OPTIONS_PER_SELECT * MAX_SELECTS);
      if (deletable.length === 0) {
        await interaction.editReply({ content: t('none_deletable') });
        return;
      }

      // The custom ID carries only the page: keywords can exceed its 100-character cap.
      const selectRows = [];
      for (let i = 0; i < deletable.length; i += OPTIONS_PER_SELECT) {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`delete_reply|${String(i / OPTIONS_PER_SELECT)}`)
          .setPlaceholder(t('select_placeholder'))
          .addOptions(
            deletable.slice(i, i + OPTIONS_PER_SELECT).map((reply, idx) => {
              const text = reply.reply.length > 60 ? `${reply.reply.slice(0, 60)}...` : reply.reply;
              return (
                new StringSelectMenuOptionBuilder()
                  .setLabel(`${String(i + idx + 1)}. ${text}`)
                  // `lean()` strips the `id` virtual; use the raw _id.
                  .setValue(reply._id.toString())
              );
            }),
          );
        selectRows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
      }

      let previewContent = t('image_preview_header');
      deletable.forEach((reply, idx) => {
        if (reply.reply.startsWith('http'))
          previewContent += `${String(idx + 1)} - ${reply.reply}\n`;
      });

      await interaction.editReply({ content: previewContent, components: selectRows });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:delete_reply.failed',
        interaction.guildId,
      );
    }
  }
}
