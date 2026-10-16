import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
export default class ai_whitelist_list extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ai_whitelist_list',
      category: 'ai',
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
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    try {
      // A repo `err` is re-thrown into the surrounding catch.
      const docsResult = await repos.userApiSetting.listAll();
      if (!docsResult.ok) throw docsResult.error;
      const docs = docsResult.value;
      if (docs.length === 0) {
        await interaction.editReply({
          content: bot.translator?.t('replies:ai_whitelist.empty') ?? '',
        });
        return;
      }

      const header = bot.translator?.t('replies:ai_whitelist.header', { count: docs.length }) ?? '';
      const lines = docs.map((d) => `<@${d.userId}> — \`${d.provider}\` / \`${d.model}\``);

      // Build pages that stay within Discord's 2000-character limit.
      const MAX = 2000;
      const pages: string[] = [];
      let current = header;
      for (const line of lines) {
        const next = `${current}\n${line}`;
        if (next.length > MAX) {
          pages.push(current);
          current = line;
        } else {
          current = next;
        }
      }
      pages.push(current);

      // Each page is delivered independently: a rejected follow-up used
      // to escape to the catch below, where `replyForError` overwrote
      // page 1 with the error line.
      await sendPagedEphemeralReply(interaction, pages, {
        logger: bot.logger,
        partialNotice: (failed) =>
          bot.translator?.t('replies:common.pages_failed', { count: failed }) ?? '',
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
