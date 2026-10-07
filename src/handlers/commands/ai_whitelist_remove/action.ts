import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
export default class ai_whitelist_remove extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ai_whitelist_remove',
      category: 'ai',
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!bot.isAdmin(interaction.user.id)) {
      await interaction.editReply({
        content: bot.translator?.t('errors:permission.admin_only_short') ?? '',
      });
      return;
    }

    const target = interaction.options.getUser('user', true);
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    try {
      // A repo `err` is re-thrown into the surrounding catch.
      const removedResult = await repos.userApiSetting.deleteByUserId(target.id);
      if (!removedResult.ok) throw removedResult.error;
      if (!removedResult.value) {
        await interaction.editReply({
          content:
            bot.translator?.t('replies:ai_whitelist.not_in', { user: target.displayName }) ?? '',
        });
        return;
      }
      await interaction.editReply({
        content:
          bot.translator?.t('replies:ai_whitelist.removed', { user: target.displayName }) ?? '',
      });
    } catch (err) {
      await replyForError(
        interaction,
        bot,
        err,
        'replies:ai_whitelist.failed',
        interaction.guildId,
      );
    }
  }
}
