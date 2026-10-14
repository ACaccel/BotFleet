import type {
  ActionRowBuilder,
  ClientUser,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { BaseBot } from '@bot';

import { buildHelpOverview } from './build-help-embed';

interface OverviewPayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<StringSelectMenuBuilder>[];
}

/** The overview reply, shared by `/help` and the category menu's way back to it. */
export const helpOverviewPayload = (
  bot: BaseBot,
  botUser: ClientUser | null,
  isAdmin: boolean,
): OverviewPayload => {
  const { embed, menu } = buildHelpOverview(bot.commandHandlers, bot.translator, {
    isAdmin,
    botName: botUser?.username ?? '',
    botAvatarUrl: botUser?.displayAvatarURL(),
    intro: bot.helpMessage,
  });
  return { embeds: [embed], components: menu ? [menu] : [] };
};
