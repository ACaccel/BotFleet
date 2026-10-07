import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import * as activity from '../../../plugins/activity/internal';

export default class activity_create extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'activity_create',
      category: 'server_activity',
      options: {
        string: [
          {
            name: 'title',
            required: true,
          },
          {
            name: 'duration',
            required: true,
          },
          {
            name: 'description',
            required: false,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await activity.handleActivityCreate(interaction, bot);
  }
}
