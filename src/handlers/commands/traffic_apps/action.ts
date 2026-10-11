import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { buildAppsReport } from '../traffic-shared/apps-report';
import { RANK_ROW_LIMIT } from '../traffic-shared/dashboard';
import { trafficCommandOptions, type TrafficOptionSpec } from '../traffic-shared/options';
import { runTrafficAction } from '../traffic-shared/run';

const OPTIONS: TrafficOptionSpec = { defaultRange: '7d', maxTopN: RANK_ROW_LIMIT };

/**
 * `/traffic apps` — command, component and modal use per application in the
 * channels the invoker may see, from interaction records. With `app`, one
 * application's types, trend and most active members.
 */
export default class traffic_apps extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_apps',
      category: 'server_activity',
      options: trafficCommandOptions(OPTIONS, { user: [{ name: 'app', required: false }] }),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const applicationId = interaction.options.getUser('app')?.id;
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'visible',
      build: (context) => buildAppsReport(context, applicationId),
    });
  }
}
