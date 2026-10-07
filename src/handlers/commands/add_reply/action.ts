import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class add_reply extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'add_reply',
      category: 'auto_reply',
      options: {
        string: [
          {
            name: 'keyword',
            required: true,
          },
          {
            name: 'reply',
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
      const input = getRequiredString(interaction, 'keyword');
      const reply = getRequiredString(interaction, 'reply');

      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      // Repo methods return Result<T, DatabaseError>. An `err` is
      // re-thrown so the surrounding catch runs the standard log +
      // failure-reply path.
      const existPairResult = await repos.reply.findExactPair(input, reply);
      if (!existPairResult.ok) throw existPairResult.error;
      const existPair = existPairResult.value;

      if (existPair.length === 0) {
        const createResult = await repos.reply.create(input, reply);
        if (!createResult.ok) throw createResult.error;
        await interaction.editReply({
          content: bot.translator?.t('replies:add_reply.added', { input, reply }) ?? '',
        });
      } else {
        await interaction.editReply({
          content: bot.translator?.t('replies:add_reply.already_exists', { input, reply }) ?? '',
        });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:add_reply.failed',
        interaction.guild?.id,
      );
    }
  }
}
