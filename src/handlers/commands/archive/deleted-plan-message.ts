import { Routes } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import {
  isArchivePublicStatusEmbed,
  readArchivePublicMessage,
  withArchivePublicMessageLock,
} from '../../../infra/archive/public-message';
import { rows } from './presentation-common';
import { manageBack } from './manage-common';

/** The backend supersedes old notifications before this final public replacement. */
export const publishDeletedArchivePlan = async (
  bot: BaseBot,
  reference: { channelId: string; messageId: string } | undefined,
): Promise<void> => {
  if (reference === undefined) return;
  const t = bindTranslator(bot.translator);
  try {
    await withArchivePublicMessageLock(reference.channelId, reference.messageId, async () => {
      const message = await readArchivePublicMessage(
        bot.client,
        reference.channelId,
        reference.messageId,
      );
      // Navigation may have replaced the old notice with another item's panel or bulk cleanup.
      if (!isArchivePublicStatusEmbed(message.embeds[0])) return;
      await bot.client.rest.patch(Routes.channelMessage(reference.channelId, reference.messageId), {
        body: {
          content: t('replies:archive.manage_deleted'),
          embeds: [],
          attachments: [],
          components: rows([manageBack('plans', t)]).map((row) => row.toJSON()),
          allowed_mentions: { parse: [] },
        },
      });
    });
  } catch (error) {
    bot.logger?.warn({ err: error }, 'Could not replace deleted archive plan notice');
  }
};
