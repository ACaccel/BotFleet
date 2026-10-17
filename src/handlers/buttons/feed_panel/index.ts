import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { handleFeedPanelInteraction } from '../../feed-panel/interaction';

export default class feed_panel extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await handleFeedPanelInteraction(interaction, bot);
  }
}
