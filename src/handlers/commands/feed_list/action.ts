/**
 * `/feed list` — show the feed subscriptions in this guild.
 *
 * Authority is ungated, reach is not: the listing is filtered to the
 * channels the invoker can already see. A subscription in a channel
 * they have no access to is not shown, and its absence is not hinted
 * at — a count of "3 more you cannot see" would leak the very fact the
 * channel's permissions exist to hide.
 *
 * The reply is ephemeral and paginated, because one guild's
 * subscriptions can exceed a single message.
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
import { requireGuildRepos } from '../../require-guild-repos';
import { formatSubscriptionPages } from './format-subscriptions';

export default class feed_list extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'feed_list',
      category: 'utility',
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Falls back to the key, never to '', which Discord rejects.
    const t = bindTranslator(bot.translator);
    try {
      const guild = interaction.guild;
      const repos = await requireGuildRepos(bot, interaction);
      // Already replied on null; the `guild` half restates that for tsc.
      if (repos === null || guild === null) return;

      // A repo `err` is re-thrown into the surrounding catch.
      const listed = await repos.feedSubscription.list();
      if (!listed.ok) throw listed.error;

      // Visibility is decided per destination channel, against a
      // resolved `GuildMember` — an id would take `permissionsFor`'s
      // nullable overload and turn "uncached" into "denied". An
      // unresolvable channel or member hides the row: the safe
      // direction for a filter whose job is to withhold.
      const invoker = guild.members.cache.get(interaction.user.id);
      const visible = listed.value.filter((doc) => {
        const channel = guild.channels.cache.get(doc.channel_id);
        const gate = channel?.isThread() === true ? channel.parent : channel;
        if (gate === null || gate === undefined || invoker === undefined) return false;
        return gate.permissionsFor(invoker)?.has(PermissionFlagsBits.ViewChannel) === true;
      });

      // The header counts what is shown, not what exists.
      const pages = formatSubscriptionPages(visible, t);
      if (pages.length === 0) {
        await interaction.editReply({ content: t('replies:feed.list_empty') });
        return;
      }
      await sendPagedEphemeralReply(interaction, pages, {
        logger: bot.logger,
        partialNotice: (failed) => t('replies:common.pages_failed', { count: failed }),
      });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:feed.failed', interaction.guildId);
    }
  }
}
