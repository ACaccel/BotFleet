import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { runUserTrafficCommand } from '../traffic-shared/user-traffic-command';

/**
 * `/traffic user` — a specified target user's message-activity stats over
 * a time window: an overview (total, daily average, share of visible
 * traffic, busiest period, rank among active users), a time-trend line
 * chart, and a channel-distribution bar chart.
 *
 * Privacy is gated by the INVOKER, never the target — see
 * `traffic-shared/user-traffic-command` for the shared body and the full
 * disclosure contract. `visibility` mirrors `/traffic me` (default
 * `ephemeral`): a `public` reply is additionally capped by the command
 * channel's rank.
 */
export default class traffic_user extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'traffic_user',
      category: 'server_activity',
      options: {
        user: [{ name: 'user', required: true }],
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
      command: 'traffic_user',
      resolveSubject: (source) => {
        const target = source.options.getUser('user', true);
        const targetMember = source.options.getMember('user');
        return {
          id: target.id,
          displayName:
            targetMember && 'displayName' in targetMember
              ? targetMember.displayName
              : target.username,
        };
      },
    });
  }
}
