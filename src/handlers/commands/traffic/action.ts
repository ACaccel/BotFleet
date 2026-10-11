import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { RANK_ROW_LIMIT } from '../traffic-shared/dashboard';
import { trafficCommandOptions, type TrafficOptionSpec } from '../traffic-shared/options';
import { buildOverviewReport } from '../traffic-shared/overview-report';
import { runTrafficAction } from '../traffic-shared/run';

const OPTIONS: TrafficOptionSpec = { defaultRange: '7d', maxTopN: RANK_ROW_LIMIT };

/**
 * `/traffic overview` — the server's member activity in the channels the
 * invoker may see: headline counts with the change against the previous
 * period, retention, trend, interactions and content, member and channel
 * rankings, the weekday x hour heat map, and the top messages. `visibility`
 * sets both the reply audience and the channel-rank ceiling.
 */
export default class traffic extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic',
      category: 'server_activity',
      options: trafficCommandOptions(OPTIONS),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'visible',
      build: buildOverviewReport,
    });
  }
}
