import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { EMOJI_RANK_LIMIT } from '../traffic-shared/dashboard';
import { buildEmojiReport, EMOJI_KINDS, EMOJI_SOURCES } from '../traffic-shared/emoji-report';
import {
  readChoice,
  trafficCommandOptions,
  type TrafficOptionSpec,
} from '../traffic-shared/options';
import { runTrafficAction } from '../traffic-shared/run';
import { USAGE_ORDERS } from '../traffic-shared/usage-ranking';

const OPTIONS: TrafficOptionSpec = {
  defaultRange: '30d',
  maxTopN: EMOJI_RANK_LIMIT,
  adjustableTopN: true,
};

const choices = (values: readonly string[]) => values.map((value) => ({ value }));

/**
 * `/traffic emoji` — use of the guild's custom emoji in message text and
 * reactions, over every channel by design (the reply names no channel).
 * Unused emoji are listed so `order: least` finds them.
 */
export default class traffic_emoji extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_emoji',
      category: 'stats',
      options: trafficCommandOptions(OPTIONS, {
        string: [
          { name: 'order', required: false, choices: choices(USAGE_ORDERS) },
          { name: 'kind', required: false, choices: choices(EMOJI_KINDS) },
          { name: 'source', required: false, choices: choices(EMOJI_SOURCES) },
        ],
      }),
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const filters = {
      order: readChoice(interaction, 'order', USAGE_ORDERS, 'most'),
      kind: readChoice(interaction, 'kind', EMOJI_KINDS, 'all'),
      source: readChoice(interaction, 'source', EMOJI_SOURCES, 'all'),
    };
    await runTrafficAction(interaction, bot, {
      options: OPTIONS,
      scope: 'all',
      build: (context) => buildEmojiReport(context, filters),
    });
  }
}
