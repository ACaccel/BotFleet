import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { buildChannelReport } from '../traffic-shared/channel-report';
import { RANK_ROW_LIMIT } from '../traffic-shared/dashboard';
import { trafficCommandOptions, type TrafficOptionSpec } from '../traffic-shared/options';
import { runTrafficAction } from '../traffic-shared/run';

const OPTIONS: TrafficOptionSpec = { defaultRange: '7d', maxTopN: RANK_ROW_LIMIT };

/** Every place members can write: text, announcement, forum and media channels, voice and stage chat, threads. */
const CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;

/**
 * `/traffic channel` — one channel's member activity, by default with the
 * threads under it. A channel the invoker may not count gets the same "not
 * found or no permission" answer as one that does not exist; with
 * `visibility: public` the command channel's rank caps what may be counted.
 */
export default class traffic_channel extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_channel',
      category: 'server_activity',
      options: trafficCommandOptions(OPTIONS, {
        channel: [{ name: 'channel', required: true, channelTypes: CHANNEL_TYPES }],
        boolean: [{ name: 'include_threads', required: false }],
      }),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const channelId = interaction.options.getChannel('channel', true).id;
    const includeThreads = interaction.options.getBoolean('include_threads') ?? true;
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'visible',
      build: (context) => buildChannelReport(context, channelId, includeThreads),
    });
  }
}
