import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { ARCHIVE_PROCESS_ID } from '../../../src/infra/archive/owner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import {
  archiveJobDeletions,
  finalizeArchiveJobDeletion,
  recoverArchiveRunConsumers,
  recoverArchiveOrphanConsumers,
  reserveArchiveRunConsumer,
} from '../../../src/infra/archive/lifecycle';
import { MongoArchiveRepo } from '../../../src/persistence/repositories/archive.repo';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { asGuildId } from '../../../src/core/ids';
import { withFreshConnection } from '../helpers/mongo';

const actor = { userId: '456', channelId: '789' };
const plan = (runId = 'run', patch: Record<string, unknown> = {}) => ({
  _id: runId,
  guildId: '123',
  status: 'planned',
  createdAt: 10,
  schemaHash: 'archive-v2',
  operations: 0,
  unresolved: 0,
  journalBytes: 0,
  issues: [],
  ...patch,
});
afterEach(() => vi.restoreAllMocks());

describe('archive control deletion lifecycle', () => {
  it('deletes fully rolled-back metadata while preserving restored data and replay protection', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(plan('restored', { status: 'rolled-back', operations: 2 }) as never);
      await connection.collection('archive_repair_operations').insertMany([
        { runId: 'restored', state: 'rolled-back', before: { content: 'recovery image' } },
        { runId: 'restored', state: 'planned' },
      ]);
      await connection
        .collection('messages')
        .insertOne({ messageId: '1', content: 'restored data' });
      await connection
        .collection('archive_revisions')
        .insertOne({ messageId: '1', content: 'retained observation' });
      await connection.collection('fetches').insertOne({ channelId: '2', lastMessageId: '1' });
      const control = new ArchiveControlService(connection, '123');
      expect(await control.canDeletePlan('restored')).toBe(true);
      expect((await control.plans()).plans[0]).toMatchObject({
        runId: 'restored',
        deletable: true,
      });
      expect(await control.deletePlan('restored')).toEqual({ runId: 'restored', deleted: true });
      expect(await control.deletePlan('restored')).toEqual({ runId: 'restored', deleted: true });
      expect(await connection.collection('archive_repair_operations').countDocuments()).toBe(0);
      expect(await connection.collection('archive_plan_deletions').countDocuments()).toBe(1);
      for (const collection of ['messages', 'archive_revisions', 'fetches'])
        expect(await connection.collection(collection).countDocuments()).toBe(1);
    }));

  it.each(['verified', 'journaled', 'conflict', 'unknown', null])(
    'rejects a rolled-back label with unresolved operation state %s',
    async (state) =>
      withFreshConnection(async (connection) => {
        await connection
          .collection('archive_repair_runs')
          .insertOne(plan('restored', { status: 'rolled-back' }) as never);
        await connection
          .collection('archive_repair_operations')
          .insertOne({ runId: 'restored', ...(state === null ? {} : { state }) });
        const control = new ArchiveControlService(connection, '123');
        expect(await control.canDeletePlan('restored')).toBe(false);
        await expect(control.deletePlan('restored')).rejects.toThrow();
        expect(await connection.collection('archive_repair_operations').countDocuments()).toBe(1);
        expect(await connection.collection('archive_plan_deletions').countDocuments()).toBe(0);
      }),
  );

  it.each([
    'conflict',
    'journal',
    'consumer',
    'queued',
    'running',
    'rolling-back',
    'rollback-conflicts',
  ])('protects rolled-back recovery with %s evidence or work', async (reason) =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(
        plan('restored', {
          status: ['rolling-back', 'rollback-conflicts'].includes(reason) ? reason : 'rolled-back',
          ...(reason === 'consumer' ? { controlConsumers: ['request'] } : {}),
        }) as never,
      );
      if (reason === 'conflict' || reason === 'journal')
        await connection
          .collection(reason === 'conflict' ? 'archive_repair_conflicts' : 'archive_journals')
          .insertOne({ runId: 'restored' });
      if (reason === 'queued' || reason === 'running')
        await connection
          .collection('archive_jobs')
          .insertOne({ guildId: '123', runId: 'restored', status: reason });
      const control = new ArchiveControlService(connection, '123');
      expect(await control.canDeletePlan('restored')).toBe(false);
      await expect(control.deletePlan('restored')).rejects.toThrow();
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(1);
    }),
  );

  it('stops queued work and retains its progress and archive data', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      const job = await control.submit('audit');
      await connection.collection('messages').insertOne({ messageId: '1', content: 'retained' });
      await connection.collection('fetches').insertOne({ channelId: '2', lastMessageId: '1' });
      const stopped = await control.stop(job.jobId);
      expect(stopped).toMatchObject({ status: 'cancelled', cancelRequested: true });
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
      expect(await connection.collection('messages').countDocuments()).toBe(1);
      expect(await connection.collection('fetches').countDocuments()).toBe(1);
    }));

  it('persists running deletion intent, waits for the claim to finish, and isolates guilds', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      const job = await control.submit('audit');
      await connection
        .collection('archive_jobs')
        .updateOne({ jobId: job.jobId }, { $set: { status: 'running', claimToken: 'owner' } });
      await connection.collection('archive_journals').insertOne({ runId: 'retained' });
      await connection.collection('archive_progress_details').insertMany([
        { guildId: '123', scopeId: job.jobId },
        { guildId: '999', scopeId: job.jobId },
      ]);
      await expect(
        new ArchiveControlService(connection, '999').deleteJob(job.jobId),
      ).rejects.toThrow('Unknown');
      expect(await control.deleteJob(job.jobId)).toMatchObject({ deleted: false, pending: true });
      expect(await control.status(job.jobId)).toMatchObject({
        status: 'running',
        cancelRequested: true,
        deleteRequestedAt: expect.any(Number),
      });
      expect(await finalizeArchiveJobDeletion(connection, '123', job.jobId)).toBe(false);
      await connection
        .collection('archive_jobs')
        .updateOne(
          { jobId: job.jobId, claimToken: 'owner' },
          { $set: { status: 'cancelled', finishedAt: Date.now() } },
        );
      expect(await finalizeArchiveJobDeletion(connection, '123', job.jobId)).toBe(true);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
      expect(await connection.collection('archive_progress_details').countDocuments()).toBe(1);
      expect(await connection.collection('archive_journals').countDocuments()).toBe(1);
      expect(await control.deleteJob(job.jobId)).toMatchObject({ deleted: true, pending: false });
    }));

  it('never re-enqueues deleted confirmations, including previously consumed approvals', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      const approval = await control.requestConfirmation('apply', 'run', actor);
      const job = await control.confirm(approval.token, actor);
      expect(await control.deleteJob(job.jobId)).toMatchObject({ deleted: true });
      await expect(control.confirm(approval.token, actor)).rejects.toThrow('expired');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(1);
    }));

  it('recovers deletion after receipt persistence succeeds but setting the job marker fails', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      const job = await control.submit('audit');
      vi.spyOn(connection.collection('archive_jobs'), 'updateOne').mockRejectedValueOnce(
        new Error('interrupted'),
      );
      await expect(control.deleteJob(job.jobId)).rejects.toThrow('interrupted');
      expect(await archiveJobDeletions(connection).countDocuments()).toBe(1);
      expect(await finalizeArchiveJobDeletion(connection, '123', job.jobId)).toBe(true);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('paginates every plan with ten rows, stable ties, and no private fields', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertMany(
          Array.from({ length: 23 }, (_, index) =>
            plan('run-' + String(index).padStart(2, '0'), { privateContent: 'hidden' }),
          ) as never,
        );
      await connection
        .collection('archive_repair_runs')
        .insertOne(plan('foreign', { guildId: '999' }) as never);
      const control = new ArchiveControlService(connection, '123');
      const first = await control.plans();
      const second = await control.plans({ before: first.nextCursor });
      const last = await control.plans({ before: second.nextCursor });
      expect([first.plans.length, second.plans.length, last.plans.length]).toEqual([10, 10, 3]);
      expect(
        new Set([...first.plans, ...second.plans, ...last.plans].map((entry) => entry.runId)).size,
      ).toBe(23);
      expect(JSON.stringify(first)).not.toContain('hidden');
      expect(first.plans.every((entry) => entry.deletable)).toBe(true);
      await expect(control.plans({ limit: 11 })).rejects.toThrow();
    }));

  it('deletes only never-applied plans and invalidates all outstanding approvals', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(plan('run', { operations: 1 }) as never);
      await connection.collection('archive_repair_operations').insertOne({
        _id: 'operation',
        runId: 'run',
        sequence: 0,
        state: 'planned',
        collection: 'messages',
        before: null,
        after: { messageId: '1' },
      } as never);
      const control = new ArchiveControlService(connection, '123');
      const approval = await control.requestConfirmation('apply', 'run', actor);
      expect(await control.deletePlan('run')).toEqual({ runId: 'run', deleted: true });
      expect(await connection.collection('archive_repair_operations').countDocuments()).toBe(0);
      await expect(control.confirm(approval.token, actor)).rejects.toThrow();
      expect(await control.deletePlan('run')).toEqual({ runId: 'run', deleted: true });
      await connection
        .collection('archive_repair_runs')
        .insertOne(plan('applied', { status: 'partial' }) as never);
      await connection
        .collection('archive_journals')
        .insertOne({ runId: 'applied', before: { content: 'recovery' } });
      await expect(control.deletePlan('applied')).rejects.toThrow('recovery');
      expect(await connection.collection('archive_journals').countDocuments()).toBe(1);
    }));

  it('protects consumer reservations before a queued job is inserted and releases them on stop', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      const approval = await control.requestConfirmation('apply', 'run', actor);
      const jobs = connection.collection('archive_jobs');
      const insert = jobs.updateOne.bind(jobs);
      vi.spyOn(jobs, 'updateOne').mockImplementationOnce(async (...args) => {
        await expect(control.deletePlan('run')).rejects.toThrow('active');
        return insert(...args);
      });
      const job = await control.confirm(approval.token, actor);
      await expect(control.deletePlan('run')).rejects.toThrow('active');
      await control.stop(job.jobId);
      expect(await control.deletePlan('run')).toEqual({ runId: 'run', deleted: true });
    }));

  it('prevents a confirmation paused before reservation from reviving a deleted plan', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      const approval = await control.requestConfirmation('apply', 'run', actor);
      const runs = connection.collection('archive_repair_runs');
      const update = runs.updateOne.bind(runs);
      let deleted = false;
      vi.spyOn(runs, 'updateOne').mockImplementation(async (...args) => {
        if ('$addToSet' in args[1] && !deleted) {
          deleted = true;
          await control.deletePlan('run');
        }
        return update(...args);
      });
      await expect(control.confirm(approval.token, actor)).rejects.toThrow('deleted');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('keeps deleted queued jobs outside repository claims', async () =>
    withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(asGuildId('123'));
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const control = new ArchiveControlService(connection, '123');
      const job = await control.submit('audit');
      await connection
        .collection('archive_jobs')
        .updateOne({ jobId: job.jobId }, { $set: { deleteRequestedAt: Date.now() } });
      expect(await repo.claimJob('owner', Date.now(), 60000)).toBeUndefined();
    }));
  it.each(['planned', 'rolled-back'])(
    'resumes %s metadata deletion after a crash following the durable marker',
    async (status) =>
      withFreshConnection(async (connection) => {
        await connection
          .collection('archive_repair_runs')
          .insertOne(plan('run', { operations: 1, status }) as never);
        await connection
          .collection('archive_repair_operations')
          .insertOne({ runId: 'run', state: status, before: { content: 'plan image' } });
        await connection
          .collection('messages')
          .insertOne({ messageId: '1', content: 'archive record' });
        const control = new ArchiveControlService(connection, '123');
        vi.spyOn(
          connection.collection('archive_repair_operations'),
          'deleteMany',
        ).mockRejectedValueOnce(new Error('interrupted cleanup'));
        await expect(control.deletePlan('run')).rejects.toThrow('interrupted cleanup');
        expect(
          await connection.collection('archive_repair_runs').findOne({ _id: 'run' } as never),
        ).toHaveProperty('deleteRequestedAt');
        expect((await control.plans()).plans).toEqual([]);
        expect(await control.deletePlan('run')).toEqual({ runId: 'run', deleted: true });
        expect(await connection.collection('archive_repair_operations').countDocuments()).toBe(0);
        expect(await connection.collection('messages').countDocuments()).toBe(1);
      }),
  );

  it('never deletes a job selected just before its worker claim', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      const job = await control.submit('audit');
      const receipts = archiveJobDeletions(connection);
      const persist = receipts.updateOne.bind(receipts);
      vi.spyOn(receipts, 'updateOne').mockImplementationOnce(async (...args) => {
        await connection
          .collection('archive_jobs')
          .updateOne(
            { jobId: job.jobId, status: 'queued' },
            { $set: { status: 'running', claimToken: 'racing-owner' } },
          );
        return persist(...args);
      });
      expect(await control.deleteJob(job.jobId)).toMatchObject({ deleted: false, pending: true });
      expect(await control.status(job.jobId)).toMatchObject({
        status: 'running',
        cancelRequested: true,
      });
    }));
  it('releases plan reservations after a crash between job removal and consumer cleanup', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      const approval = await control.requestConfirmation('apply', 'run', actor);
      const job = await control.confirm(approval.token, actor);
      vi.spyOn(connection.collection('archive_repair_runs'), 'updateOne').mockRejectedValueOnce(
        new Error('consumer cleanup unavailable'),
      );
      await expect(control.deleteJob(job.jobId)).rejects.toThrow('consumer cleanup unavailable');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
      expect(await finalizeArchiveJobDeletion(connection, '123', job.jobId)).toBe(true);
      expect(await control.deletePlan('run')).toMatchObject({ deleted: true });
    }));
  it('recovers completed consumer releases while preserving queued and interrupted-submit reservations', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(
          plan('run', { controlConsumers: ['finished', 'queued', 'interrupted-submit'] }) as never,
        );
      await connection.collection('archive_jobs').insertMany([
        {
          jobId: '123:finished',
          requestId: 'finished',
          guildId: '123',
          runId: 'run',
          status: 'complete',
        },
        {
          jobId: '123:queued',
          requestId: 'queued',
          guildId: '123',
          runId: 'run',
          status: 'queued',
        },
      ]);
      await recoverArchiveRunConsumers(connection, '123');
      expect(
        await connection.collection('archive_repair_runs').findOne({ _id: 'run' } as never),
      ).toHaveProperty('controlConsumers', ['queued', 'interrupted-submit']);
    }));

  it('does not reopen a validated deletion when a concurrent validator rejects stale active work', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      let rejectFirst!: () => void;
      let validated!: () => void;
      let finishSecond!: () => void;
      const stale = new Promise<void>((resolve) => {
        rejectFirst = resolve;
      });
      const accepted = new Promise<void>((resolve) => {
        validated = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      vi.spyOn(connection.collection('archive_jobs'), 'findOne').mockImplementationOnce(
        async () => {
          await stale;
          return { jobId: 'previously-active' } as never;
        },
      );
      const operations = connection.collection('archive_repair_operations');
      const remove = operations.deleteMany.bind(operations);
      vi.spyOn(operations, 'deleteMany').mockImplementationOnce(async (...args) => {
        validated();
        await blocked;
        return remove(...args);
      });
      const first = control.deletePlan('run');
      const failed = expect(first).rejects.toThrow('active');
      await expect
        .poll(async () =>
          Boolean(
            (await connection.collection('archive_repair_runs').findOne({ _id: 'run' } as never))?.[
              'deleteRequestedAt'
            ],
          ),
        )
        .toBe(true);
      const second = control.deletePlan('run');
      await accepted;
      rejectFirst();
      await failed;
      expect(
        await connection.collection('archive_repair_runs').findOne({ _id: 'run' } as never),
      ).toHaveProperty('deleteRequestedAt');
      await expect(control.submit('verify', { runId: 'run' })).rejects.toThrow('Unknown');
      finishSecond();
      expect(await second).toMatchObject({ deleted: true });
    }));
  it('recovers only positively proven dead-client orphan reservations after an interrupted verify enqueue', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      const control = new ArchiveControlService(connection, '123');
      vi.spyOn(connection.collection('archive_jobs'), 'updateOne').mockRejectedValueOnce(
        new Error('interrupted before insertion'),
      );
      await expect(control.submit('verify', { runId: 'run' })).rejects.toThrow(
        'interrupted before insertion',
      );
      const runs = connection.collection('archive_repair_runs');
      const reserved = await runs.findOne({ _id: 'run' } as never);
      const requestId = (reserved?.['controlConsumers'] as string[])[0]!;
      const key = createHash('sha256').update(requestId).digest('hex');
      await runs.updateOne({ _id: 'run' } as never, {
        $set: { ['controlConsumerOwners.' + key]: `${hostname()}:12345:previous` },
      });
      const admin = connection.db!.admin();
      const commands = vi.spyOn(admin, 'command').mockResolvedValue({ inprog: [{ opid: 1 }] });
      vi.spyOn(connection.db!, 'admin').mockReturnValue(admin);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      await recoverArchiveOrphanConsumers(connection, '123');
      expect((await runs.findOne({ _id: 'run' } as never))?.['controlConsumers']).toEqual([
        requestId,
      ]);
      commands.mockResolvedValue({ inprog: [] });
      await recoverArchiveOrphanConsumers(connection, '123');
      expect((await runs.findOne({ _id: 'run' } as never))?.['controlConsumers']).toEqual([]);
      expect(await control.deletePlan('run')).toMatchObject({ deleted: true });
    }));

  it('preserves live enqueue reservations even when their jobs have not yet been inserted', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan() as never);
      await reserveArchiveRunConsumer(connection, '123', 'run', 'current-enqueue');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      await recoverArchiveOrphanConsumers(connection, '123');
      const run = await connection
        .collection('archive_repair_runs')
        .findOne({ _id: 'run' } as never);
      expect(run?.['controlConsumers']).toEqual(['current-enqueue']);
      expect(Object.values(run?.['controlConsumerOwners'] as Record<string, string>)).toEqual([
        ARCHIVE_PROCESS_ID,
      ]);
      expect(kill).not.toHaveBeenCalled();
    }));

  it('fences startup orphan cleanup when a live confirmation replay takes over its reservation', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(
        plan('run', {
          controlConsumers: ['replay'],
          controlConsumerOwners: {
            [createHash('sha256').update('replay').digest('hex')]: `${hostname()}:12345:previous`,
          },
        }) as never,
      );
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const admin = connection.db!.admin();
      vi.spyOn(connection.db!, 'admin').mockReturnValue(admin);
      vi.spyOn(admin, 'command').mockImplementationOnce(async () => {
        await reserveArchiveRunConsumer(connection, '123', 'run', 'replay');
        return { inprog: [] };
      });
      await recoverArchiveOrphanConsumers(connection, '123');
      expect(
        (await connection.collection('archive_repair_runs').findOne({ _id: 'run' } as never))?.[
          'controlConsumers'
        ],
      ).toEqual(['replay']);
    }));
});
