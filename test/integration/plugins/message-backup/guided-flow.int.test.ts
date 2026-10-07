import { mongo, type Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveJob } from '../../../../src/core/archive/types';
import { ArchiveControlService } from '../../../../src/infra/archive/control';
import { ArchiveRepairService } from '../../../../src/plugins/message-backup/repair/service';
import type { RepairDependencies } from '../../../../src/plugins/message-backup/repair/contracts';
import { withFreshConnection } from '../../helpers/mongo';

const actor = { userId: '456', channelId: '789' };
const settings = { schemaHash: 'archive-v2', policyHash: () => 'synthetic-policy' };

/** Exercise durable control/executor boundaries without a Discord transport or worker timer. */
async function executeQueued(connection: Connection, service: ArchiveRepairService, jobId: string) {
  const jobs = connection.collection<ArchiveJob>('archive_jobs');
  const job = await jobs.findOne({ jobId, guildId: '123', status: 'queued' });
  if (job === null || job.command === 'refresh-attachment')
    throw new Error('Expected a queued repair job');
  await jobs.updateOne({ jobId }, { $set: { status: 'running', startedAt: Date.now() } });
  const result = await service.execute({ ...job, command: job.command });
  await jobs.updateOne(
    { jobId },
    { $set: { status: result.status, result: { ...result }, finishedAt: Date.now() } },
  );
  return result;
}

describe('guided archive durable workflow', () => {
  it.each([false, true])(
    'reuses plan/apply/accept with automatic verification and fresh acceptance checks (changed=%s)',
    async (changed) =>
      withFreshConnection(async (connection) => {
        await connection.collection('messages').insertOne({
          _id: new mongo.ObjectId(),
          messageId: '111',
          channelId: '222',
          userId: '333',
          authorKind: 'human',
          timestamp: '123',
          content: 'synthetic original',
        });
        const backfill = vi.fn<RepairDependencies['backfill']>(async () => ({
          status: 'complete',
          counts: { channels: 1, scanned: 1 },
          issues: [],
        }));
        const service = new ArchiveRepairService(connection, {
          policyHash: settings.policyHash(),
          schemaHash: settings.schemaHash,
          classify: () => 'included',
          assertOwner: async () => undefined,
          ensureCapacity: async () => undefined,
          withMaintenance: async (operation) => operation(),
          isCancelled: async () => false,
          backfill,
        });
        const control = new ArchiveControlService(connection, '123', settings);
        const planJob = await control.submit('plan', { notification: { channelId: '789' } });
        const planned = await executeQueued(connection, service, planJob.jobId);
        expect(planned.status).toBe('complete');
        const resumedControl = new ArchiveControlService(connection, '123', settings);
        const savedPlan = await resumedControl.status(planJob.jobId);
        expect(savedPlan.runId).toBe(planned.runId);
        const runId = savedPlan.runId!;
        const inspected = await resumedControl.manifest(runId);
        expect(inspected.run.status).toBe('planned');
        expect(inspected.run.operations).toBe(1);
        expect(backfill).not.toHaveBeenCalled();
        expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');

        const approval = await resumedControl.requestConfirmation('apply', runId, actor);
        const appliedJob = await resumedControl.confirm(approval.token, actor);
        const replay = await new ArchiveControlService(connection, '123', settings).confirm(
          approval.token,
          actor,
        );
        expect(replay.jobId).toBe(appliedJob.jobId);
        const applied = await executeQueued(connection, service, appliedJob.jobId);
        expect(applied.status).toBe('complete');
        expect(applied.counts['pending']).toBe(0);
        expect(backfill).toHaveBeenCalledOnce();
        const completed = await connection
          .collection('archive_repair_runs')
          .findOne({ _id: runId as never });
        expect(completed?.['status']).toBe('complete');
        expect(completed?.['verifiedAt']).toEqual(expect.any(Number));
        expect(completed).not.toHaveProperty('acceptedAt');
        expect(completed).not.toHaveProperty('expiresAt');

        const acceptance = await resumedControl.requestConfirmation('accept', runId, actor);
        if (changed)
          await connection
            .collection('messages')
            .updateOne({ messageId: '111' }, { $set: { timestamp: 'invalid timestamp' } });
        const acceptanceJob = await resumedControl.confirm(acceptance.token, actor);
        const accepted = await executeQueued(connection, service, acceptanceJob.jobId);
        const finalRun = await connection
          .collection('archive_repair_runs')
          .findOne({ _id: runId as never });
        if (changed) {
          expect(accepted.status).toBe('partial');
          expect(finalRun?.['status']).toBe('partial');
          expect(finalRun).not.toHaveProperty('expiresAt');
        } else {
          expect(accepted.status).toBe('complete');
          expect(finalRun?.['status']).toBe('accepted');
          expect(Number(finalRun?.['expiresAt']) - Number(finalRun?.['acceptedAt'])).toBe(
            72 * 60 * 60 * 1000,
          );
        }
        const commands = await connection
          .collection<ArchiveJob>('archive_jobs')
          .find({ guildId: '123' }, { projection: { command: 1 } })
          .toArray();
        expect(commands.map((job) => job.command).sort()).toEqual(['accept', 'apply', 'plan']);
        expect(await connection.collection('archive_schedule').countDocuments({})).toBe(0);
      }),
  );
});
