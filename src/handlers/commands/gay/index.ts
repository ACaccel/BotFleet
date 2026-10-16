import { GuildMember, type ChatInputCommandInteraction, type User } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { meterBar, pairReading, singleReading } from './meter';
import { dailyReading } from './daily-reading';
import { lookupGuildRepos } from '../../require-guild-repos';
import { buildAllowedChannelSet } from '../traffic-shared/allowed-channels';

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
    const userIds =
      second === undefined || second.id === first.id ? [first.id] : [first.id, second.id];
    const now = Date.now();
    let reading =
      second === undefined || second.id === first.id
        ? singleReading(first.id, bot.timeZone, now)
        : pairReading(first.id, second.id, bot.timeZone, now);
    const guild = interaction.guild;
    const policy = bot.permissionRankPolicy;
    if (guild !== null && policy !== undefined) {
      const member =
        interaction.member instanceof GuildMember
          ? interaction.member
          : guild.members.cache.get(interaction.user.id);
      const lookup = lookupGuildRepos(bot, guild.id);
      if (member !== undefined && lookup.kind === 'ready') {
        await interaction.deferReply();
        const repos = lookup.repos;
        const records = await repos.gayStats.listChannels();
        if (records.ok) {
          const channelIds = buildAllowedChannelSet({
            guild,
            member,
            policy,
            mode: 'public',
            commandChannelId: interaction.channelId,
            records: records.value,
          });
          reading = await dailyReading({
            userIds,
            channelIds: [...channelIds],
            timeZone: bot.timeZone,
            now,
            stats: repos.gayStats,
            snapshots: repos.gayReading,
          });
        }
      }
    }

    let content: string;
    if (second === undefined || second.id === first.id) {
      const { percent, commentKey } = reading;
      content = t('replies:gay.single', { name, percent, bar: meterBar(percent) });
      content += `\n> ${t(commentKey)}`;
    } else {
      const { percent, commentKey } = reading;
      const other = nameOf(second, interaction.options.getMember('user2'));
      content = t('replies:gay.pair', { name, other, percent, bar: meterBar(percent) });
      content += `\n> ${t(commentKey)}`;
    }
    // Names are member-chosen text; nothing in the reading may ping.
    const reply = { content, allowedMentions: { parse: [] } };
    if (interaction.deferred) await interaction.editReply(reply);
    else await interaction.reply(reply);
  }
}
