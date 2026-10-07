import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  InteractionReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { ArchiveBulkDeletionService } from '../../../infra/archive/bulk-deletion';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveAccess } from './access';
import { archiveBulkProgressReply, archiveBulkReviewReply } from './bulk-presentation';
import { publishArchiveReply } from './replies';
import { publishDeletedArchivePlan } from './deleted-plan-message';
import { publishArchiveJobDeletion } from './deleted-job-message';
import { rows } from './presentation-common';
import { manageBack } from './manage-common';
import { archiveBulkPublicReply } from './bulk-public-reply';

export const archiveManageBulkDeletion = async (
  action: string,
  id: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<InteractionReplyOptions> => {
  const service = new ArchiveBulkDeletionService(access.connection, access.guildId);
  const actor = {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    messageId: interaction.message.id,
  };
  if (action === 'bulk-result') {
    const progress = await service.progress(id, actor);
    return archiveBulkProgressReply(progress, bot, progress.complete);
  }
  if (action !== 'bulk-confirm') {
    const kind = action === 'delete-all-jobs' ? 'jobs' : 'plans';
    await publishArchiveReply(
      interaction,
      archiveBulkPublicReply({
        content: bindTranslator(bot.translator)('replies:archive.bulk_preparing'),
        components: rows([manageBack(kind, bindTranslator(bot.translator))]),
      }),
      bot,
      access,
    );
    return archiveBulkReviewReply(await service.review(kind, actor), bot);
  }
  type Progress = Awaited<ReturnType<ArchiveBulkDeletionService['execute']>>;
  let latest: Progress | undefined;
  let publishing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = (): Promise<void> => {
    if (publishing !== undefined) return publishing;
    if (latest === undefined) return Promise.resolve();
    const payload = archiveBulkProgressReply(latest, bot, false);
    publishing = publishArchiveReply(interaction, payload, bot, access)
      .catch((error: unknown) => {
        bot.logger?.warn({ err: error }, 'Archive bulk progress publication deferred');
      })
      .finally(() => {
        publishing = undefined;
      });
    return publishing;
  };
  try {
    const result = await service.execute(
      id,
      actor,
      async (progress) => {
        latest = progress;
        if (timer === undefined) {
          await publish();
          timer = setInterval(() => {
            void publish();
          }, 10_000);
          timer.unref();
        }
      },
      async (item) => {
        if (item.notification === undefined) return;
        if (
          item.notification?.channelId === actor.channelId &&
          item.notification.messageId === actor.messageId
        )
          return;
        if (item.kind === 'jobs' && ['deleted', 'pending'].includes(item.outcome))
          await publishArchiveJobDeletion(item.id, item.outcome === 'pending', bot, access);
        if (item.kind === 'plans' && item.outcome === 'deleted')
          await publishDeletedArchivePlan(bot, item.notification);
      },
    );
    return archiveBulkProgressReply(result, bot, true);
  } finally {
    if (timer !== undefined) clearInterval(timer);
    await publishing;
  }
};
