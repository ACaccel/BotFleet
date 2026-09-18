import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { buildGiveawayModal } from './build-giveaway-modal';

export default class giveaway_create extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'giveaway_create',
      category: 'server_activity',
      options: {
        string: [
          {
            name: 'destination',
            required: false,
            choices: [{ value: 'current' }, { value: 'configured' }],
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const useConfiguredChannel = interaction.options.getString('destination') === 'configured';
    await interaction.showModal(buildGiveawayModal(bot.translator, useConfiguredChannel));
  }
}
