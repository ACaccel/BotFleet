import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveJob } from '../../../core/archive/types';
import { bindTranslator } from '../../../core/i18n';
import { ArchiveAccessError, type ArchiveAccess } from '../../commands/archive/access';
import { archiveJobReply, archiveManifestReply } from '../../commands/archive/presentation';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { publishArchiveReply } from '../../commands/archive/replies';

/** Mutations use the exact live job binding rather than redirecting an old job to its successor. */
export const executeArchivePublicJobControl = async (
  interaction: ButtonInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
  jobId: string,
  view: 'changes' | 'technical' | 'cancel',
): Promise<void> => {
  if (view === 'cancel') {
    const current = await access.connection.collection<ArchiveJob>('archive_jobs').findOne({
      guildId: access.guildId,
      jobId,
      status: { $in: ['queued', 'running'] },
      'notification.channelId': access.debugId,
      'notification.messageId': interaction.message.id,
      'notification.supersededAt': { $exists: false },
    });
    if (
      current === null ||
      !['queued', 'running'].includes(current.status) ||
      current.notification?.supersededAt !== undefined ||
      current.notification?.channelId !== access.debugId ||
      current.notification?.messageId !== interaction.message.id ||
      bot.client.user === null ||
      interaction.message.author.id !== bot.client.user.id
    )
      throw new ArchiveAccessError('replies:archive.invalid_state');
    const job = await access.control.cancel(jobId);
    await publishArchiveReply(
      interaction,
      archivePublicReply(
        await archiveJobReply(job, bot, access.control, null, undefined, [
          bindTranslator(bot.translator)('replies:archive.view_cancelled_writes'),
        ]),
        { jobId },
      ),
      bot,
      access,
    );
    return;
  }
  const job = await access.control.status(jobId);
  if (job.runId === undefined) throw new ArchiveAccessError('replies:archive.navigation_stale');
  await publishArchiveReply(
    interaction,
    archivePublicReply(
      await archiveManifestReply(
        job.runId,
        bot,
        access.control,
        {
          userId: interaction.user.id,
          channelId: interaction.channelId,
          messageId: interaction.message.id,
        },
        { view },
      ),
      { jobId: job.jobId },
    ),
    bot,
    access,
  );
};
