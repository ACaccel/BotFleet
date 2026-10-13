import type { StringSelectMenuInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '@select-menu';
import { requireGuildRepos } from '../../require-guild-repos';
import { canDeleteReply } from '../../commands/reply-shared/authority';

export default class delete_reply extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const value = interaction.values[0] ?? '';
    const answer = async (key: string, params?: Record<string, string>): Promise<void> => {
      await interaction.reply({
        content: bot.translator?.t(`replies:delete_reply.${key}`, params) ?? '',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    };

    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    // Repo methods return Result<T, DatabaseError>. An `err` is
    // re-thrown so it propagates to the dispatcher's catch.
    const pairResult = await repos.reply.findById(value);
    if (!pairResult.ok) throw pairResult.error;
    const pair = pairResult.value;
    if (!pair) {
      await answer('record_not_found');
      return;
    }
    // Recheck: the clicker's permissions may have changed since the menu was built.
    if (!canDeleteReply(interaction, bot, pair.created_by)) {
      await answer('none_deletable');
      return;
    }
    const deleteResult = await repos.reply.deleteById(value);
    if (!deleteResult.ok) throw deleteResult.error;

    await answer('deleted', { key: pair.input, reply: pair.reply });
  }
}
