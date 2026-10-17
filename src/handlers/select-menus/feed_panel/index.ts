import type { StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '../ssm-handler';
import { handleFeedPanelInteraction } from '../../feed-panel/interaction';

export default class feed_panel extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await handleFeedPanelInteraction(interaction, bot);
  }
}
