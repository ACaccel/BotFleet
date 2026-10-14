import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { STICKER_RANK_LIMIT } from '../traffic-shared/dashboard';
import {
  readChoice,
  trafficCommandOptions,
  type TrafficOptionSpec,
} from '../traffic-shared/options';
import { runTrafficAction } from '../traffic-shared/run';
import { buildStickerReport } from '../traffic-shared/sticker-report';
import { USAGE_ORDERS } from '../traffic-shared/usage-ranking';

const OPTIONS: TrafficOptionSpec = {
  defaultRange: '30d',
  maxTopN: STICKER_RANK_LIMIT,
  adjustableTopN: true,
};

/**
 * `/traffic sticker` — use of the guild's stickers over every channel by
 * design (the reply names no channel). Unused stickers are listed so
 * `order: least` finds them.
 */
export default class traffic_sticker extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_sticker',
      category: 'stats',
      options: trafficCommandOptions(OPTIONS, {
        string: [
          { name: 'order', required: false, choices: USAGE_ORDERS.map((value) => ({ value })) },
        ],
      }),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const order = readChoice(interaction, 'order', USAGE_ORDERS, 'most');
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'all',
      build: (context) => buildStickerReport(context, order),
    });
  }
}
