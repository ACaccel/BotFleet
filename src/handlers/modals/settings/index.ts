import type { ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '../modal-handler';
import { handleSettingsInteraction } from '../../../application/guild-settings/interaction';

export default class settings extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await handleSettingsInteraction(interaction, bot);
  }
}
