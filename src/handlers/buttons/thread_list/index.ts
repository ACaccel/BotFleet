import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { canManageThread } from '../../thread-moderation-access';
import { buildThreadListReply } from '../../thread-list-view';
import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';

export default class thread_list extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const t = bindTranslator(bot.translator);
    const refuse = async (key: string): Promise<void> => {
      const reply = { content: t(key), allowedMentions: { parse: [] as never[] } };
      if (interaction.deferred) await interaction.editReply({ ...reply, components: [] });
      else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
    };
    try {
      const match = /^thread_list\|(\d{17,20})\|(\d{17,20})\|([1-9]\d{0,8})$/u.exec(
        interaction.customId,
      );
      if (
        !match ||
        !interaction.guild ||
        !interaction.channel?.isThread() ||
        interaction.channelId !== match[2] ||
        interaction.message.author.id !== bot.clientId ||
        !interaction.message.flags.has(MessageFlags.Ephemeral) ||
        interaction.message.interactionMetadata?.user.id !== match[1]
      ) {
        await refuse('replies:thread_moderation.list_stale');
        return;
      }
      if (match[1] !== interaction.user.id) {
        await refuse('replies:thread_moderation.list_forbidden');
        return;
      }
      await interaction.deferUpdate();
      if (!bot.threadModerationEnabled) {
        await refuse('replies:thread_moderation.disabled');
        return;
      }
      const repos = bot.getRepos(interaction.guild.id);
      if (repos === undefined) {
        await refuse('replies:thread_moderation.unavailable');
        return;
      }
      const thread = await interaction.channel.fetch();
      if (!(await canManageThread(bot, interaction.guild.id, thread, interaction.user.id))) {
        await refuse('replies:thread_moderation.forbidden');
        return;
      }
      const result = await repos.threadModeration.listBlocked(bot.clientId, thread.id);
      if (!result.ok) throw result.error;
      await interaction.editReply(
        buildThreadListReply(bot, thread.id, interaction.user.id, result.value, Number(match[3])),
      );
    } catch (error) {
      if (interaction.deferred) await interaction.editReply({ components: [] });
      await replyForError(
        interaction,
        bot,
        error,
        'replies:thread_moderation.list_failed',
        interaction.guildId,
      );
    }
  }
}
