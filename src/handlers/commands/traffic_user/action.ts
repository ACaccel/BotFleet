import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { RANK_ROW_LIMIT } from '../traffic-shared/dashboard';
import { trafficCommandOptions, type TrafficOptionSpec } from '../traffic-shared/options';
import { buildPersonReport } from '../traffic-shared/person-report';
import { runTrafficAction } from '../traffic-shared/run';

const OPTIONS: TrafficOptionSpec = {
  defaultRange: '7d',
  // Another member's activity is shown only to the invoker unless they choose otherwise.
  defaultVisibility: 'ephemeral',
  maxTopN: RANK_ROW_LIMIT,
};

/**
 * `/traffic user` — another member's activity, in the layout of `/traffic me`.
 * Privacy is gated by the INVOKER, never the target: only channels the invoker
 * may count are counted, and no visible activity (including a target outside
 * the guild) gives the same neutral no-data answer.
 */
export default class traffic_user extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_user',
      category: 'stats',
      options: trafficCommandOptions(OPTIONS, { user: [{ name: 'user', required: true }] }),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const target = interaction.options.getUser('user', true);
    const targetMember = interaction.options.getMember('user');
    const displayName =
      targetMember !== null && 'displayName' in targetMember
        ? targetMember.displayName
        : (target.globalName ?? target.username);
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'visible',
      build: (context) => buildPersonReport(context, { id: target.id, displayName }),
    });
  }
}
