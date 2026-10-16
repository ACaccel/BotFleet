import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { handleSettingsInteraction } from '../../../application/guild-settings/interaction';

export default class settings extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await handleSettingsInteraction(interaction, bot);
  }
}
