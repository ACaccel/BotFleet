import type { ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '../modal-handler';
import { handleFeedPanelInteraction } from '../../feed-panel/interaction';

export default class feed_panel extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await handleFeedPanelInteraction(interaction, bot);
  }
}
