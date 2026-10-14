import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import { handleGiveawayDeletePrompt } from '../giveaway-shared/delete';

export default class giveaway_delete extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'giveaway_delete',
      category: 'events',
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    // Instead of asking for a message id, present the guild's active
    // giveaways as a select menu; the `giveaway_delete` select
    // handler performs the deletion on selection.
    await handleGiveawayDeletePrompt(interaction, bot);
  }
}
