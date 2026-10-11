import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { RANK_ROW_LIMIT } from '../traffic-shared/dashboard';
import { trafficCommandOptions, type TrafficOptionSpec } from '../traffic-shared/options';
import { buildPersonReport } from '../traffic-shared/person-report';
import { runTrafficAction } from '../traffic-shared/run';

const OPTIONS: TrafficOptionSpec = { defaultRange: '7d', maxTopN: RANK_ROW_LIMIT };

/**
 * `/traffic me` — the invoker's own activity in the channels they may see:
 * counts, rank and share, active days, reactions, command use, conversation
 * partners, channel distribution, and a personal heat map.
 */
export default class traffic_me extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_me',
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
      build: (context) =>
        buildPersonReport(context, {
          id: context.member.id,
          displayName: context.member.displayName,
        }),
    });
  }
}
