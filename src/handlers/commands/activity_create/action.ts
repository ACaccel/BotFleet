import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { getOptionalString } from '../../../infra/discord/options';
import { buildActivityModal } from '../activity-shared/build-modal';

/** `/activity create`: open the form; posting happens on submit. */
export default class activity_create extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'activity_create',
      category: 'events',
      guildOnly: true,
      options: { role: [{ name: 'role', required: false }] },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.showModal(
      buildActivityModal(bot.translator, getOptionalString(interaction, 'role')),
    );
  }
}
