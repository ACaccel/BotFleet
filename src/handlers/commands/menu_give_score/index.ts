import type { ContextMenuCommandType, MessageContextMenuCommandInteraction } from 'discord.js';
import { ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { scoreFor } from '../give_score/score';

/** `give_score` for one message: the message, not its author, is scored. */
export default class menu_give_score extends Command {
  constructor() {
    super();
    this.setConfig({
      // Stable ASCII id; the user-facing Discord name is resolved
      // from `commands:menu_give_score.name`.
      name: 'menu_give_score',
      category: 'fun',
      type: ApplicationCommandType.Message as ContextMenuCommandType,
    });
  }

  public override async execute(
    interaction: MessageContextMenuCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    const message = interaction.targetMessage;
    // Seeded by message id, so each message keeps its own score all day.
    const { score, commentKey } = scoreFor(`message:${message.id}`, bot.timeZone);
    const author = message.member?.displayName ?? message.author.displayName;

    await interaction.reply({
      content: `${t('replies:give_score.message_result', { persona: bot.personaName, author, url: message.url, score })}\n> ${t(commentKey)}`,
      allowedMentions: { parse: [] },
    });
  }
}
