import { MessageFlags, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { paginateLines } from '../../../infra/discord/paginate';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';

/** `/role temp list`: every active temp role, soonest expiry first, privately. */
export default class temp_role_list extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'temp_role_list', category: 'community', guildOnly: true });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:temp_role.${key}`, params) ?? '';
    try {
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      const result = await repos.tempRole.listAll();
      if (!result.ok) throw result.error;
      const roles = [...result.value].sort((a, b) => a.expires_at - b.expires_at);
      if (roles.length === 0) {
        await interaction.editReply({ content: t('list_empty') });
        return;
      }
      const lines = roles.map((doc) =>
        t('list_line', {
          role: `<@&${doc.role_id}>`,
          creator: `<@${doc.creator_id}>`,
          expiry: time(Math.floor(doc.expires_at / 1000), TimestampStyles.RelativeTime),
        }),
      );
      await sendPagedEphemeralReply(
        interaction,
        paginateLines([t('list_header', { count: roles.length }), ...lines]),
        {
          logger: bot.logger,
          partialNotice: (failed) =>
            bot.translator?.t('replies:common.pages_failed', { count: failed }) ?? '',
        },
      );
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:temp_role.failed', interaction.guildId);
    }
  }
}
