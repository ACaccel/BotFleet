import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class list_reply extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'list_reply',
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
      const keyword = getRequiredString(interaction, 'keyword');
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      // A repo `err` is re-thrown into the surrounding catch.
      const replyListResult = await repos.reply.findByInput(keyword);
      if (!replyListResult.ok) throw replyListResult.error;
      const replyList = replyListResult.value;
      if (replyList.length === 0) {
        await interaction.editReply({
          content: bot.translator?.t('replies:list_reply.not_found', { keyword }) ?? '',
        });
      } else {
        let content = bot.translator?.t('replies:list_reply.header', { keyword }) ?? '';
        replyList.map((e, i) => {
          content += `> ${i + 1}. ${e.reply}\n`;
        });
        await interaction.editReply({ content });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:list_reply.failed',
        interaction.guild?.id,
      );
    }
  }
}
