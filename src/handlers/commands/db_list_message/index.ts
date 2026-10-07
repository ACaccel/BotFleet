import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { canReadArchiveSource } from '../../../infra/discord/archive-access';
import { asChannelId } from '../../../core/ids';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { parseStartEnd } from './parse-range';
import { sanitizeMentions } from './sanitize-mentions';
import { chunkLines } from './chunk-output';
import { formatMessageLines } from './format-message-lines';
import { buildArchiveAttachment } from './build-archive-attachment';
import { ARCHIVABLE_CHANNEL_TYPES, makeDisplayNameResolver } from './resolve-display-name';

export default class db_list_message extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'db_list_message',
      category: 'utility',
      options: {
        channel: [{ name: 'channel', required: true }],
        string: [
          { name: 'date', required: true },
          { name: 'print', required: false, choices: [{ value: 'no' }, { value: 'yes' }] },
        ],
        number: [{ name: 'hour', required: false }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply({ content: t('errors:command.guild_not_found') });
        return;
      }
      const repos = bot.getRepos(guild.id);
      if (!repos) {
        await interaction.editReply({ content: t('errors:db.not_found') });
        return;
      }
      const channel = interaction.options.getChannel('channel', true);
      if (!ARCHIVABLE_CHANNEL_TYPES.has(channel.type)) {
        await interaction.editReply({ content: t('replies:db_list_message.not_text_channel') });
        return;
      }
      if (!(await canReadArchiveSource(guild, channel.id, interaction.user.id))) {
        await interaction.editReply({ content: t('replies:db_list_message.source_unavailable') });
        return;
      }
      const date = interaction.options.getString('date', true);
      const print = (interaction.options.getString('print', false) as string | null) ?? 'no';
      const hour = interaction.options.getInteger('hour', false);
      const range = parseStartEnd(date, hour);
      if (!range) {
        await interaction.editReply({ content: t('replies:db_list_message.invalid_args') });
        return;
      }
      // A repo `err` is re-thrown into the surrounding catch.
      const messagesResult = await repos.message.findByChannelAndTimestampRange(
        asChannelId(channel.id),
        range.startMs,
        range.endMs,
      );
      if (!messagesResult.ok) throw messagesResult.error;
      const messages = messagesResult.value;
      if (messages.length === 0) {
        const scopeText =
          hour === null || hour === undefined
            ? t('replies:db_list_message.scope_full_day', { date })
            : t('replies:db_list_message.scope_hour', { date, hour });
        await interaction.editReply({
          content: t('replies:db_list_message.no_messages', { channelId: channel.id, scopeText }),
        });
        return;
      }
      const lines = await formatMessageLines(messages, {
        resolveDisplayName: makeDisplayNameResolver(guild),
        t,
      });
      const rangeText =
        hour === null || hour === undefined
          ? t('replies:db_list_message.range_full_day', { date })
          : `${date} ${hour.toString().padStart(2, '0')}:00 - ${(hour + 1).toString().padStart(2, '0')}:00`;
      if (print === 'yes') {
        if (interaction.channelId !== channel.id) {
          await interaction.editReply({ content: t('replies:db_list_message.same_channel_only') });
          return;
        }
        const outChannel = interaction.channel;
        if (!outChannel || !outChannel.isSendable()) {
          await interaction.editReply({
            content: t('replies:db_list_message.no_output_channel'),
          });
          return;
        }
        const chunks = chunkLines(lines.map(sanitizeMentions));
        await interaction.editReply({
          content: t('replies:db_list_message.found_split', {
            count: messages.length,
            rangeText,
            channelId: channel.id,
            chunks: chunks.length,
          }),
        });
        for (const chunk of chunks) {
          await outChannel.send({ content: chunk, flags: MessageFlags.SuppressEmbeds });
        }
        return;
      }
      const attachment = buildArchiveAttachment({
        channelId: channel.id,
        date,
        hour,
        text: lines.join('\n'),
      });
      await interaction.editReply({
        content: t('replies:db_list_message.found', {
          count: messages.length,
          rangeText,
          channelId: channel.id,
        }),
        files: [attachment],
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:db_list_message.failed',
        interaction.guild?.id,
      );
    }
  }
}
