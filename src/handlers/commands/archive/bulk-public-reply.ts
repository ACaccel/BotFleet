import { Routes, type InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { withArchivePublicMessageLock } from '../../../infra/archive/public-message';

const bulkReplies = new WeakSet<InteractionReplyOptions>();

/** Bulk management owns the entire card while its durable result/resume marker is present. */
export const archiveBulkPublicReply = (
  payload: InteractionReplyOptions,
): InteractionReplyOptions => {
  bulkReplies.add(payload);
  return payload;
};
export const isArchiveBulkReply = (payload: InteractionReplyOptions): boolean =>
  bulkReplies.has(payload);

export const publishArchiveBulkReply = async (
  bot: BaseBot,
  channelId: string,
  messageId: string,
  payload: InteractionReplyOptions,
): Promise<void> => {
  await withArchivePublicMessageLock(channelId, messageId, async () => {
    await bot.client.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: {
        content: payload.content ?? '',
        embeds: [],
        attachments: [],
        components: (payload.components ?? []).map((row) => ('toJSON' in row ? row.toJSON() : row)),
        allowed_mentions: { parse: [] },
      },
    });
  });
};
