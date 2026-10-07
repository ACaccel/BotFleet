import { type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { replyForError } from '../../../infra/discord/reply-for-error';

import { renderTrafficCharts } from '../traffic-shared/chart';
import { readTrafficOptions } from '../traffic-shared/options';
import type { TFn } from '../traffic-shared/types';
import { buildAllowedChannelSet } from '../traffic-shared/visibility-filter';
import { resolveWindow } from '../traffic-shared/window';

import { aggregateTraffic } from './aggregation';
import { computeTrend, countTrafficMessages } from './trend';
import { buildTrafficView } from './view';

/**
 * `/traffic overview` — guild message-traffic charts and statistics across the
 * time / channel / user dimensions, rendered from the persisted message
 * archive.
 *
 * Privacy is a dual filter (see visibility-filter): a channel's stats
 * appear only when the invoker clears both the operator rank ceiling
 * and Discord-native `ViewChannel`. The ceiling tracks the reply
 * audience — `public` is capped by both the invoker's clearance and the
 * command channel's rank; `ephemeral` is capped by the invoker's
 * clearance alone (only they see it). `visibility` thus sets both the
 * ceiling and whether the reply is posted to the channel.
 */
export default class traffic extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic',
      category: 'server_activity',
      options: {
        string: [
          {
            name: 'visibility',
            required: false,
            choices: [{ value: 'ephemeral' }, { value: 'public' }],
          },
          {
            name: 'range',
            required: false,
            choices: [{ value: '24h' }, { value: '7d' }, { value: '30d' }],
          },
        ],
        number: [{ name: 'top_n', required: false, min: 1, max: 25 }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t: TFn = (key, params) => bot.translator?.t(key, params) ?? '';
    // Read options before deferring: ephemerality is fixed at defer time.
    const options = readTrafficOptions(interaction);
    await interaction.deferReply(
      options.visibility === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {},
    );
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply({ content: t('errors:command.guild_not_found') });
        return;
      }
      const repos = bot.getRepos(guild.id);
      const policy = bot.permissionRankPolicy;
      // `policy` is registered eagerly at construction, so an absent one
      // means the bot is not yet fully wired for this guild's data.
      if (!repos || !policy) {
        await interaction.editReply({ content: t('errors:db.not_configured') });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const allowed = buildAllowedChannelSet({
        guild,
        member,
        policy,
        mode: options.visibility,
        commandChannelId: interaction.channelId,
      });

      const window = resolveWindow(options.range, Date.now());
      const aggregate = await aggregateTraffic(repos, window, allowed);
      if (aggregate.totalMessages === 0) {
        await interaction.editReply({ content: t('replies:traffic.no_data') });
        return;
      }

      // Compare against the immediately preceding equal-length window,
      // filtered by the same allowed channels so the trend stays private.
      const previousWindow = window.endMs - window.startMs;
      const previousTotal = await countTrafficMessages(
        repos,
        window.startMs - previousWindow,
        window.startMs,
        allowed,
      );
      const trend = computeTrend(aggregate.totalMessages, previousTotal);

      const view = buildTrafficView(aggregate, options.topN, options.range, trend, guild, t);
      await interaction.editReply({
        embeds: view.embeds,
        files: renderTrafficCharts(view.charts),
      });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:traffic.failed', interaction.guild?.id);
    }
  }
}
