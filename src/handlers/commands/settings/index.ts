import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { openSettingsPanel } from '../../../application/guild-settings/interaction';

export default class settings extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'settings', category: 'utility', guildOnly: true });
  }
  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await openSettingsPanel(interaction, bot);
  }
}
