import type { ChatInputCommandInteraction, GuildMember, User } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { meterBar, pairReading, singleReading } from './meter';

const nameOf = (user: User, member: unknown): string =>
  member !== null && typeof member === 'object' && 'displayName' in member
    ? (member as GuildMember).displayName
    : user.displayName;

export default class gay extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'gay',
      category: 'fun',
      guildOnly: true,
      options: {
        user: [
          { name: 'user', required: true },
          { name: 'user2', required: false },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    const first = interaction.options.getUser('user', true);
    const second = interaction.options.getUser('user2') ?? undefined;
    const name = nameOf(first, interaction.options.getMember('user'));

    let content: string;
    if (second === undefined || second.id === first.id) {
      const { percent, commentKey } = singleReading(first.id, bot.timeZone);
      content = t('replies:gay.single', { name, percent, bar: meterBar(percent) });
      content += `\n> ${t(commentKey)}`;
    } else {
      const { percent, commentKey } = pairReading(first.id, second.id, bot.timeZone);
      const other = nameOf(second, interaction.options.getMember('user2'));
      content = t('replies:gay.pair', { name, other, percent, bar: meterBar(percent) });
      content += `\n> ${t(commentKey)}`;
    }
    // Names are member-chosen text; nothing in the reading may ping.
    await interaction.reply({ content, allowedMentions: { parse: [] } });
  }
}
