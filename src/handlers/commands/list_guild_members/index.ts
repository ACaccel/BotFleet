import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
const MAX_DESCRIPTION_LENGTH = 3800;

const chunkLines = (lines: string[], maxLength: number): string[] => {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    if (!currentChunk) {
      currentChunk = line;
      continue;
    }

    if (currentChunk.length + 1 + line.length <= maxLength) {
      currentChunk += `\n${line}`;
      continue;
    }

    chunks.push(currentChunk);
    currentChunk = line;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
};

export const buildMemberLine = (member: GuildMember): string => {
  const user = member.user;
  // Escape backslashes before brackets so a trailing "\" in the display
  // name cannot neutralise the escaped "]" and break out of the link text.
  const displayName = member.displayName.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  const profileUrl = `https://discord.com/users/${user.id}`;
  const badge = user.bot ? '`[BOT]` ' : '';
  return `${badge}[${displayName}](${profileUrl}) - <@${user.id}>`;
};

export default class list_guild_members extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'list_guild_members',
      category: 'admin',
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();

    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.guild_info_not_found') ?? '',
        });
        return;
      }

      const memberMap = await guild.members.fetch();
      const members = Array.from(memberMap.values()).sort((a, b) => {
        if (a.user.bot !== b.user.bot) {
          return Number(a.user.bot) - Number(b.user.bot);
        }
        return a.displayName.localeCompare(b.displayName, 'zh-Hant');
      });

      if (members.length === 0) {
        await interaction.editReply({
          content: bot.translator?.t('replies:list_guild_members.empty') ?? '',
        });
        return;
      }

      const lines = members.map(buildMemberLine);
      const chunks = chunkLines(lines, MAX_DESCRIPTION_LENGTH);

      const t = (key: string, params?: Record<string, string | number>): string =>
        bot.translator?.t(key, params) ?? '';
      const title = t('replies:list_guild_members.title', { name: guild.name });
      const totalText = t('replies:list_guild_members.total', {
        total: members.length,
        users: members.filter((m) => !m.user.bot).length,
        bots: members.filter((m) => m.user.bot).length,
      });

      const firstEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(chunks[0] ?? null)
        .setColor(EMBED_COLORS.info)
        .setFooter({
          text: t('replies:list_guild_members.footer', {
            totalText,
            current: 1,
            total: chunks.length,
          }),
        });

      await interaction.editReply({ embeds: [firstEmbed] });

      for (let i = 1; i < chunks.length; i++) {
        const pageEmbed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(chunks[i] ?? null)
          .setColor(EMBED_COLORS.info)
          .setFooter({
            text: t('replies:list_guild_members.footer', {
              totalText,
              current: i + 1,
              total: chunks.length,
            }),
          });

        await interaction.followUp({ embeds: [pageEmbed] });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:list_guild_members.failed',
        interaction.guild?.id,
      );
    }
  }
}
