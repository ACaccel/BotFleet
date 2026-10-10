import type { APIEmbed } from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveJob } from '../../../core/archive/types';
import { archiveJobProgress } from '../../../core/archive/progress';
import { renderArchivePublicStatus } from '../../../core/archive/public-status-renderer';
import { publicArchiveSourceName } from '../../../infra/archive/public-message';
import type { ArchiveAccess } from './access';
import { archivePublicRecord } from './public-reference';

/** A list panel reads the latest durable progress without taking over the worker's notice. */
export const archivePlanProgressEmbed = async (
  bot: BaseBot,
  access: ArchiveAccess,
  runId: string,
): Promise<APIEmbed | undefined> => {
  const record = await archivePublicRecord(access, { runId });
  let job = record !== undefined && 'job' in record ? record.job : undefined;
  if (job === undefined) {
    // Planning persists the run before its originating job receives the runId result.
    const run = await access.connection
      .collection<{
        _id: string;
        guildId: string;
        originatingJobId?: string;
      }>('archive_repair_runs')
      .findOne({ _id: runId, guildId: access.guildId }, { projection: { originatingJobId: 1 } });
    if (typeof run?.originatingJobId === 'string')
      job =
        (await access.connection.collection<ArchiveJob>('archive_jobs').findOne({
          guildId: access.guildId,
          jobId: run.originatingJobId,
          'notification.supersededAt': { $exists: false },
          $or: [{ runId: { $exists: false } }, { runId }],
        })) ?? undefined;
  }
  if (job === undefined || bot.translator === undefined) return undefined;
  const snapshot = archiveJobProgress(job);
  const activity = snapshot.activities[0];
  const currentSource =
    activity === undefined
      ? undefined
      : (publicArchiveSourceName(bot.client, access.guildId, activity.sourceId) ??
        (/^\d{1,20}$/.test(activity.sourceId)
          ? bot.translator.t('replies:archive.public_source_id', { id: activity.sourceId })
          : bot.translator.t('replies:archive.public_source_hidden')));
  return renderArchivePublicStatus(snapshot, bot.translator, {
    currentSource,
    lastSuccessfulUpdateAtMs: job.notification?.deliveredAt,
  });
};
