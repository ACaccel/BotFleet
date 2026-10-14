import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { executeThreadModeration } from '../thread-moderation';

export default class thread_list extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'thread_list',
      category: 'community',
      guildOnly: true,
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await executeThreadModeration(interaction, bot, 'list');
  }
}
