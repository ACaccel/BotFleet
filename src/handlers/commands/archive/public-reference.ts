import type { ArchiveJob, ArchivePeriodicRun } from '../../../core/archive/types';
import { ArchiveAccessError, type ArchiveAccess } from './access';

export type ArchivePublicTarget = { jobId: string } | { runId: string } | { scanId: string };
export const archivePublicRecord = async (
  access: ArchiveAccess,
  target: ArchivePublicTarget,
): Promise<{ job: ArchiveJob } | { scan: ArchivePeriodicRun } | undefined> => {
  if ('scanId' in target) {
    const scan = await access.connection
      .collection<ArchivePeriodicRun>('archive_periodic_runs')
      .findOne({ _id: 'current', runId: target.scanId });
    return scan === null ? undefined : { scan };
  }
  const jobs = access.connection.collection<ArchiveJob>('archive_jobs');
  let job = await jobs.findOne(
    {
      guildId: access.guildId,
      ...('runId' in target ? { 'notification.supersededAt': { $exists: false } } : {}),
      ...('jobId' in target ? { jobId: target.jobId } : { runId: target.runId }),
    },
    { sort: { createdAt: -1 } },
  );
  if (job?.notification?.supersededAt !== undefined && job.runId !== undefined)
    job = await jobs.findOne(
      {
        guildId: access.guildId,
        runId: job.runId,
        'notification.supersededAt': { $exists: false },
      },
      { sort: { createdAt: -1 } },
    );
  return job === null ? undefined : { job };
};

export const archiveConfirmationReference = async (
  access: ArchiveAccess,
  token: string,
  userId: string,
  scope: 'panel' | 'job' = 'panel',
): Promise<{ channelId: string; messageId: string } | undefined> => {
  const confirmation = await access.connection
    .collection<{
      _id: string;
      runId: string;
      publicMessage?: { channelId: string; messageId: string };
    }>('archive_control_confirmations')
    .findOne({
      _id: token,
      guildId: access.guildId,
      userId,
      channelId: access.debugId,
    });
  if (confirmation === null) return undefined;
  if (scope === 'panel' && confirmation.publicMessage !== undefined) {
    if (confirmation.publicMessage.channelId !== access.debugId)
      throw new ArchiveAccessError('replies:archive.confirm_stale');
    return confirmation.publicMessage;
  }
  return archivePublicReference(access, { runId: confirmation.runId });
};

/** Bind approval to its displayed panel without moving the worker's durable notice. */
export const bindArchiveConfirmationMessage = async (
  access: ArchiveAccess,
  token: string,
  userId: string,
  reference: { channelId: string; messageId: string },
): Promise<void> => {
  const result = await access.connection
    .collection<{
      _id: string;
      publicMessage?: { channelId: string; messageId: string };
    }>('archive_control_confirmations')
    .updateOne(
      {
        _id: token,
        guildId: access.guildId,
        userId,
        channelId: access.debugId,
        consumedAt: { $exists: false },
        expiresAt: { $gt: Date.now() },
        $or: [{ publicMessage: { $exists: false } }, { publicMessage: reference }],
      },
      { $set: { publicMessage: reference } },
    );
  if (result.matchedCount !== 1) throw new ArchiveAccessError('replies:archive.confirm_stale');
};

export const archivePublicReference = async (
  access: ArchiveAccess,
  target: ArchivePublicTarget,
): Promise<{ channelId: string; messageId: string } | undefined> => {
  const record = await archivePublicRecord(access, target);
  const notification =
    record === undefined
      ? 'runId' in target
        ? (
            await access.connection
              .collection<{
                _id: string;
                guildId: string;
                publicMessage?: { channelId: string; messageId: string };
              }>('archive_repair_runs')
              .findOne({ _id: target.runId, guildId: access.guildId })
          )?.publicMessage
        : undefined
      : 'job' in record
        ? record.job.notification
        : record.scan.notification;
  if (notification?.messageId === undefined) return undefined;
  if (notification.channelId !== access.debugId)
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  return { channelId: access.debugId, messageId: notification.messageId };
};
