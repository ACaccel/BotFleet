import type { ChatInputCommandInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class delete_reply extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'delete_reply',
      category: 'auto_reply',
      options: {
        string: [
          {
            name: 'keyword',
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
      const key = getRequiredString(interaction, 'keyword');
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      // A repo `err` is re-thrown into the surrounding catch.
      const existPairResult = await repos.reply.findByInput(key);
      if (!existPairResult.ok) throw existPairResult.error;
      const existPair = existPairResult.value;

      const selectRows = [];
      for (let i = 0; i < existPair.length; i += 25) {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`delete_reply|${key}|${i / 25}`)
          .setPlaceholder(bot.translator?.t('replies:delete_reply.select_placeholder') ?? '')
          .addOptions(
            existPair.slice(i, i + 25).map((reply, idx) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(
                  reply.reply.length > 60
                    ? `${i + idx + 1}. ` + reply.reply.slice(0, 60) + '...'
                    : `${i + idx + 1}. ` + reply.reply,
                )
                // `lean()` strips the `id` virtual; use the raw _id.
                .setValue(reply._id.toString()),
            ),
          );
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        selectRows.push(row);
      }

      let previewContent = bot.translator?.t('replies:delete_reply.image_preview_header') ?? '';
      existPair.forEach((reply, idx) => {
        if (typeof reply.reply === 'string' && reply.reply.startsWith('http')) {
          previewContent += `${idx + 1} - ${reply.reply}\n`;
        }
      });

      await interaction.editReply({
        content: previewContent,
        components: [...selectRows],
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:delete_reply.failed',
        interaction.guild?.id,
      );
    }
  }
}
