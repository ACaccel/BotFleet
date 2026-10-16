import { MessageFlags, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { paginateLines } from '../../../infra/discord/paginate';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
import { visibleActivities } from '../activity-shared/visible';

/** `/activity list`: open activities in channels the member can see, soonest deadline first. */
export default class activity_list extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'activity_list', category: 'events', guildOnly: true });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:activity.${key}`, params) ?? '';
    try {
      const guild = interaction.guild;
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null || guild === null) return;
      const result = await repos.activity.listAll();
      if (!result.ok) throw result.error;
      const open = visibleActivities(guild, interaction.user.id, result.value)
        .filter((doc) => (doc.status ?? 'open') === 'open')
        .sort((a, b) => a.expired_at - b.expired_at);
      if (open.length === 0) {
        await interaction.editReply({ content: t('list_empty') });
        return;
      }
      const lines = open.map((doc) =>
        t('list_line', {
          title: doc.title,
          link: `https://discord.com/channels/${guild.id}/${doc.channel_id}/${doc.message_id}`,
          count: doc.participants.length,
          deadline: time(Math.floor(doc.expired_at / 1000), TimestampStyles.RelativeTime),
        }),
      );
      await sendPagedEphemeralReply(
        interaction,
        paginateLines([t('list_header', { count: open.length }), ...lines]),
        {
          logger: bot.logger,
          partialNotice: (failed) =>
            bot.translator?.t('replies:common.pages_failed', { count: failed }) ?? '',
        },
      );
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:activity.failed', interaction.guildId);
    }
  }
}
