import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { requireGuildRepos } from '../../require-guild-repos';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalString } from '../../../infra/discord/options';
import { paginateLines } from '../../../infra/discord/paginate';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
import type { ReplyDoc } from '../../../persistence/schemas/reply.schema';

/** One line per keyword with its reply count, most-used keywords first. */
const keywordLines = (pairs: readonly ReplyDoc[]): string[] => {
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(pair.input, (counts.get(pair.input) ?? 0) + 1);
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([input, count]) => `> ${input} (${String(count)})`);
};

export default class list_reply extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'list_reply',
      category: 'community',
      options: { string: [{ name: 'keyword', required: false, maxLength: 100 }] },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:list_reply.${key}`, params) ?? '';
    try {
      const keyword = getOptionalString(interaction, 'keyword');
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      // A repo `err` is re-thrown into the surrounding catch.
      const result =
        keyword === undefined
          ? await repos.reply.listAll()
          : await repos.reply.findByInput(keyword);
      if (!result.ok) throw result.error;
      const pairs = result.value;
      if (pairs.length === 0) {
        await interaction.editReply({
          content: keyword === undefined ? t('empty') : t('not_found', { keyword }),
          allowedMentions: { parse: [] },
        });
        return;
      }
      const lines =
        keyword === undefined
          ? [t('keywords_header', { count: pairs.length }), ...keywordLines(pairs)]
          : [
              t('header', { keyword }).trimEnd(),
              ...pairs.map((pair, i) => `> ${String(i + 1)}. ${pair.reply}`),
            ];
      await sendPagedEphemeralReply(interaction, paginateLines(lines), {
        logger: bot.logger,
        partialNotice: (failed) =>
          bot.translator?.t('replies:common.pages_failed', { count: failed }) ?? '',
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:list_reply.failed',
        interaction.guildId,
      );
    }
  }
}
