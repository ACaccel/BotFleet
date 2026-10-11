import type { ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '@modal';

import { handleGiveawayCreate } from '../../commands/giveaway-shared/create';

export default class giveaway_create_modal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await handleGiveawayCreate(interaction, bot);
  }
}
