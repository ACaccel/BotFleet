/**
 * Components on archive panels that earlier versions posted.
 *
 * Their handlers are gone, but the messages carrying them still exist, so
 * each retired custom-ID prefix stays registered and answers privately that
 * the panel is out of date. The old message is never edited: its panel keeps
 * whatever it showed, and the member runs `/archive` again for a current one.
 */
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';

import { bindTranslator } from '../core/i18n';
import { isExpiredInteractionError } from '../infra/discord/expired-interaction';
import { ButtonHandler } from './buttons/button-handler';
import { ModalHandler } from './modals/modal-handler';
import { SSMHandler } from './select-menus/ssm-handler';

type RetiredControlInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

const replyPanelStale = async (
  interaction: RetiredControlInteraction,
  bot: BaseBot,
): Promise<void> => {
  try {
    await interaction.reply({
      content: bindTranslator(bot.translator)('replies:archive.navigation_stale'),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    // A notice about a dead panel is not worth failing the dispatcher over.
    const context = { err: error, guildId: interaction.guildId, customId: interaction.customId };
    if (isExpiredInteractionError(error))
      bot.logger?.warn(context, 'Retired archive control reply expired');
    else bot.logger?.error(context, 'Retired archive control reply failed');
  }
};

export class RetiredArchiveButton extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await replyPanelStale(interaction, bot);
  }
}

export class RetiredArchiveSelectMenu extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await replyPanelStale(interaction, bot);
  }
}

export class RetiredArchiveModal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await replyPanelStale(interaction, bot);
  }
}
