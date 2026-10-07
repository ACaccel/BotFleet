import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { runUserTrafficCommand } from '../traffic-shared/user-traffic-command';

/**
 * `/traffic me` — the invoker's personal message-activity stats over a
 * time window: an overview (total, daily average, share of visible
 * traffic, busiest period, rank among active users), a personal
 * time-trend line chart, and a personal channel-distribution bar chart.
 *
 * The subject is the invoker, so the privacy filter and the counted user
 * coincide. `visibility` mirrors `/traffic overview` (default `ephemeral`); see
 * `traffic-shared/user-traffic-command` for the shared body.
 */
export default class traffic_me extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_me',
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
    await runUserTrafficCommand(interaction, bot, {
      command: 'traffic_me',
      resolveSubject: (_interaction, invoker) => ({
        id: invoker.id,
        displayName: invoker.displayName,
      }),
    });
  }
}
