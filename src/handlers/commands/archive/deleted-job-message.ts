import type { BaseBot } from '@bot';
import type { ArchiveJob } from '../../../core/archive/types';
import { ArchiveJobNotifier } from '../../../plugins/message-backup/runtime/job-notification';
import type { ArchiveAccess } from './access';

export const publishArchiveJobDeletion = async (
  jobId: string,
  pending: boolean,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<void> => {
  if (bot.translator === undefined) return;
  const notifier = new ArchiveJobNotifier({
    client: bot.client,
    registry: bot.guildRegistry,
    logger: bot.requireLogger(),
    connection: access.connection,
    guildId: access.guildId,
    translator: bot.translator,
  });
  try {
    if (!pending) await notifier.publishDeleted(jobId);
    else {
      const job = await access.connection
        .collection<ArchiveJob>('archive_jobs')
        .findOne({ jobId, guildId: access.guildId });
      if (job !== null) await notifier.publish(job);
      else await notifier.publishDeleted(jobId);
    }
  } catch (error) {
    bot.logger?.warn({ err: error }, 'Archive deletion notification deferred to worker retry');
  }
};
