import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { getOptionalString } from '../../../infra/discord/options';
import { scoreFor } from './score';

export default class give_score extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'give_score',
      category: 'fun',
      options: {
        string: [{ name: 'subject', required: false, maxLength: 100 }],
        user: [{ name: 'user', required: false }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    // A member beats free text; with neither, the invoker scores themselves.
    const user = interaction.options.getUser('user') ?? undefined;
    const member = user ? interaction.options.getMember('user') : interaction.member;
    const subjectText = getOptionalString(interaction, 'subject');
    const target = user ?? (subjectText === undefined ? interaction.user : undefined);
    const name =
      target !== undefined
        ? member && 'displayName' in member
          ? member.displayName
          : target.displayName
        : (subjectText ?? '');
    const { score, commentKey } = scoreFor(target?.id ?? subjectText ?? '', bot.timeZone);

    await interaction.reply({
      content: `${t('replies:give_score.result', { persona: bot.personaName, subject: name, score })}\n> ${t(commentKey)}`,
      allowedMentions: { parse: [] },
    });
  }
}
