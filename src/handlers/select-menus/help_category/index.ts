import type { StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '@select-menu';

import type { CommandCategory } from '../../commands/command';
import { buildCategoryEmbed } from '../../commands/help/build-help-embed';
import { CATEGORY_ORDER } from '../../commands/help/help-model';

/** The `/help` overview's category menu: swap the page for the chosen category. */
export default class help_category extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const chosen = interaction.values[0];
    const category = CATEGORY_ORDER.find((candidate) => candidate === chosen) as
      | CommandCategory
      | undefined;
    if (category === undefined) return;
    // The overview is ephemeral, so whoever picks is the member who asked.
    await interaction.update({
      embeds: [
        buildCategoryEmbed(bot.commandHandlers, bot.translator, category, {
          isAdmin: bot.isAdmin(interaction.user.id),
        }),
      ],
    });
  }
}
