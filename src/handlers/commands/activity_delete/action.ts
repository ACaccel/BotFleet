import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import * as activity from '../../../plugins/activity/internal';

export default class activity_delete extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'activity_delete',
      category: 'server_activity',
      options: {
        string: [
          {
            name: 'activity_id',
            required: true,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await activity.handleActivityDelete(interaction, bot);
  }
}
