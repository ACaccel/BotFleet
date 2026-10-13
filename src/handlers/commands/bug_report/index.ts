import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
export default class bug_report extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'bug_report',
      category: 'utility',
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
          content: bot.translator?.t('replies:bug_report.empty_content') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (bot.adminIds.length === 0) {
        throw new Error('No admin configured');
      }

      // DM every configured admin (best-effort); a single failed
      // delivery must not drop the report for the others.
      let delivered = 0;
      for (const adminId of bot.adminIds) {
        try {
          const admin = await bot.client.users.fetch(adminId);
          await admin.send(
            bot.translator?.t('replies:bug_report.admin_dm', {
              reporter: interaction.user.username,
              content,
            }) ?? '',
          );
          delivered += 1;
        } catch {
          // try the next admin
        }
      }
      if (delivered === 0) {
        throw new Error('Failed to deliver bug report to any admin');
      }
      await interaction.reply({
        content: bot.translator?.t('replies:bug_report.reported', { content }) ?? '',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:bug_report.failed',
        interaction.guild?.id,
      );
    }
  }
}
