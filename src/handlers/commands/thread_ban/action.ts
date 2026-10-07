import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { executeThreadModeration } from '../thread-moderation';

export default class thread_ban extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'thread_ban',
      category: 'admin',
      guildOnly: true,
      options: { string: [{ name: 'users', required: true }] },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await executeThreadModeration(interaction, bot, true);
  }
}
