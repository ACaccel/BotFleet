import { createHash } from 'node:crypto';
import type { Connection, Collection } from 'mongoose';
import type { ArchiveJob } from '../../core/archive/types';
import { ARCHIVE_PROCESS_ID, isTerminatedArchiveProcess } from './owner';
import { withArchivePublicMessageLock } from './public-message';

interface ArchiveJobDeletion {
  _id: string;
  guildId: string;
  jobId: string;
  requestId: string;
  runId?: string;
  requestedAt: number;
  deletedAt?: number;
  notifiedAt?: number;
  notification?: ArchiveJob['notification'];
}

export const archiveJobDeletions = (connection: Connection): Collection<ArchiveJobDeletion> =>
  connection.collection<ArchiveJobDeletion>('archive_control_deletions');

const consumerOwnerKey = (requestId: string): string =>
  createHash('sha256').update(requestId).digest('hex');

export async function reserveArchiveRunConsumer(
  connection: Connection,
  guildId: string,
  runId: string,
  requestId: string,
): Promise<void> {
  const result = await connection
    .collection<{
      _id: string;
      guildId: string;
      controlConsumers?: string[];
      controlConsumerOwners?: Record<string, string>;
      deleteRequestedAt?: number;
    }>('archive_repair_runs')
    .updateOne(
      { _id: runId, guildId, deleteRequestedAt: { $exists: false } },
      {
        $addToSet: { controlConsumers: requestId },
        $set: { ['controlConsumerOwners.' + consumerOwnerKey(requestId)]: ARCHIVE_PROCESS_ID },
      },
    );
  if (result.matchedCount !== 1) throw new Error('Repair plan was deleted or is unavailable');
}

export async function releaseArchiveRunConsumer(
  connection: Connection,
  runId: string | undefined,
  requestId: string,
): Promise<void> {
  if (runId === undefined) return;
  await connection
    .collection<{ _id: string; controlConsumers?: string[] }>('archive_repair_runs')
    .updateOne(
      { _id: runId },
      {
        $pull: { controlConsumers: requestId },
        $unset: { ['controlConsumerOwners.' + consumerOwnerKey(requestId)]: '' },
      },
    );
}

/** Only a durable terminal state proves that the worker has drained this job. */
export async function finalizeArchiveJobDeletion(
  connection: Connection,
  guildId: string,
  jobId: string,
): Promise<boolean> {
  return withArchivePublicMessageLock(guildId, 'job:' + jobId, async () => {
    const receipts = archiveJobDeletions(connection);
    const receipt = await receipts.findOne({ _id: 'job:' + jobId, guildId });
    if (receipt === null) return false;
    const jobs = connection.collection<ArchiveJob>('archive_jobs');
    const job = await jobs.findOne({ jobId, guildId });
    if (job?.status === 'running') return false;
    if (job !== null) {
      await jobs.updateOne(
        { jobId, guildId, status: { $ne: 'running' } },
        { $set: { cancelRequested: true, deleteRequestedAt: receipt.requestedAt } },
      );
      await receipts.updateOne(
        { _id: receipt._id, guildId },
        {
          $set: {
            ...(job.runId === undefined ? {} : { runId: job.runId }),
            ...(job.notification === undefined ? {} : { notification: job.notification }),
          },
        },
      );
      await connection
        .collection('archive_control_confirmations')
        .updateMany(
          { guildId, requestId: receipt.requestId },
          { $set: { purgedAt: receipt.requestedAt } },
        );
      const removed = await jobs.deleteOne({ jobId, guildId, status: { $ne: 'running' } });
      if (removed.deletedCount === 0) return false;
    }
    await releaseArchiveRunConsumer(connection, job?.runId ?? receipt.runId, receipt.requestId);
    await connection.collection('archive_progress_details').deleteMany({ guildId, scopeId: jobId });
    await receipts.updateOne(
      { _id: receipt._id, guildId },
      { $set: { deletedAt: receipt.deletedAt ?? Date.now() } },
    );
    return true;
  });
}

/** Terminal jobs retain enough identity to repair an interrupted reservation release. */
export async function recoverArchiveRunConsumers(
  connection: Connection,
  guildId: string,
): Promise<void> {
  const runs = connection.collection<{ _id: string; controlConsumers?: string[] }>(
    'archive_repair_runs',
  );
  const completed = await runs
    .aggregate<{ _id: string; consumers: { requestId: string }[] }>([
      { $match: { guildId, 'controlConsumers.0': { $exists: true } } },
      {
        $lookup: {
          from: 'archive_jobs',
          localField: 'controlConsumers',
          foreignField: 'requestId',
          pipeline: [
            { $match: { guildId, status: { $nin: ['queued', 'running'] } } },
            { $project: { _id: 0, requestId: 1 } },
          ],
          as: 'consumers',
        },
      },
      { $match: { 'consumers.0': { $exists: true } } },
      { $limit: 25 },
      { $project: { _id: 1, consumers: 1 } },
    ])
    .toArray();
  for (const run of completed)
    for (const job of run.consumers)
      await releaseArchiveRunConsumer(connection, run._id, job.requestId);
}

/** Only worker initialization may discard a missing job, after proving its client has stopped. */
export async function recoverArchiveOrphanConsumers(
  connection: Connection,
  guildId: string,
): Promise<void> {
  const runs = connection.collection<{
    _id: string;
    controlConsumers?: string[];
    controlConsumerOwners?: Record<string, string>;
  }>('archive_repair_runs');
  const cursor = runs.find({ guildId, 'controlConsumers.0': { $exists: true } });
  const stopped = new Map<string, boolean>();
  try {
    for await (const run of cursor) {
      for (const requestId of run.controlConsumers ?? []) {
        const key = consumerOwnerKey(requestId);
        const owner = run.controlConsumerOwners?.[key];
        if (owner === undefined || owner === ARCHIVE_PROCESS_ID) continue;
        if (
          await connection
            .collection('archive_jobs')
            .findOne({ guildId, requestId }, { projection: { _id: 1 } })
        )
          continue;
        if (!stopped.has(owner))
          stopped.set(owner, await isTerminatedArchiveProcess(connection, owner));
        if (stopped.get(owner) !== true) continue;
        // A replay first changes the reservation owner; this CAS preserves a concurrent live enqueue.
        await runs.updateOne(
          { _id: run._id, ['controlConsumerOwners.' + key]: owner },
          {
            $pull: { controlConsumers: requestId },
            $unset: { ['controlConsumerOwners.' + key]: '' },
          },
        );
      }
    }
  } finally {
    await cursor.close();
  }
}
