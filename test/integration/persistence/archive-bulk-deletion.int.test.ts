import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveBulkDeletionService } from '../../../src/infra/archive/bulk-deletion';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { ARCHIVE_PROCESS_ID } from '../../../src/infra/archive/owner';
import { withFreshConnection } from '../helpers/mongo';

const actor = { userId: '456', channelId: '789', messageId: '100' };
const plan = (runId: string, patch: Record<string, unknown> = {}) => ({
  _id: runId,
  guildId: '123',
  status: 'planned',
  createdAt: 1,
  schemaHash: 'archive-v2',
  operations: 0,
  ...patch,
});
afterEach(() => vi.restoreAllMocks());

describe('archive bulk deletion snapshots', () => {
  it('includes restored plans but rechecks conflicts added after approval review', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertMany([
          plan('restored', { status: 'rolled-back' }),
          plan('changed', { status: 'rolled-back' }),
          plan('partial', { status: 'rollback-conflicts' }),
        ] as never);
      await connection.collection('archive_repair_operations').insertMany([
        { runId: 'restored', state: 'rolled-back' },
        { runId: 'changed', state: 'rolled-back' },
        { runId: 'partial', state: 'conflict' },
      ]);
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('plans', actor);
      expect(review).toMatchObject({ total: 3, eligible: 2, protected: 1 });
      await connection.collection('archive_repair_conflicts').insertOne({ runId: 'changed' });
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        protected: 2,
        complete: true,
      });
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(2);
      expect(await connection.collection('archive_repair_conflicts').countDocuments()).toBe(1);
    }));

  it('reviews the entire guild and removes exact snapshot identities across every page', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await connection.collection('archive_jobs').insertMany(
        Array.from({ length: 125 }, (_, index) => ({
          _id: '123:job-' + index,
          jobId: '123:job-' + index,
          requestId: 'job-' + index,
          guildId: '123',
          command: 'audit',
          options: {},
          status: 'complete',
          cancelRequested: false,
          createdAt: Date.now() + index,
        })) as never,
      );
      const foreign = await new ArchiveControlService(connection, '999').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const inserts = vi.spyOn(connection.collection('archive_bulk_deletion_items'), 'insertMany');
      const review = await service.review('jobs', actor);
      expect(review).toMatchObject({ total: 125, eligible: 125, protected: 0 });
      expect(inserts.mock.calls.every(([items]) => items.length <= 100)).toBe(true);
      const createdAfterReview = await control.submit('audit');
      const result = await service.execute(review.reviewId, actor);
      expect(result).toMatchObject({ total: 125, deleted: 125, remaining: 0, complete: true });
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(2);
      expect(await control.status(createdAfterReview.jobId)).toHaveProperty('status', 'queued');
      expect(
        await connection.collection('archive_jobs').findOne({ jobId: foreign.jobId }),
      ).not.toBeNull();
      expect(await service.execute(review.reviewId, actor)).toEqual(result);
      expect(await control.status(createdAfterReview.jobId)).toHaveProperty('status', 'queued');
    }));

  it('requests cooperative running cancellation and preserves backup data and recovery journals', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      const queued = await control.submit('audit');
      const running = await control.submit('audit');
      await connection
        .collection('archive_jobs')
        .updateOne({ jobId: running.jobId }, { $set: { status: 'running', claimToken: 'owner' } });
      await connection.collection('messages').insertOne({ messageId: '1', content: 'retained' });
      await connection.collection('fetches').insertOne({ channelId: '2', cursor: '1' });
      await connection.collection('archive_journals').insertOne({ runId: 'retained' });
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      expect(review).toMatchObject({ total: 2, active: 2 });
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        pending: 1,
        complete: true,
      });
      await expect(control.status(queued.jobId)).rejects.toThrow('Unknown');
      expect(await control.status(running.jobId)).toMatchObject({
        status: 'running',
        cancelRequested: true,
      });
      expect(await connection.collection('messages').countDocuments()).toBe(1);
      expect(await connection.collection('fetches').countDocuments()).toBe(1);
      expect(await connection.collection('archive_journals').countDocuments()).toBe(1);
    }));

  it('keeps protected-at-review plans protected even when their state later becomes eligible', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertMany([
          plan('eligible'),
          plan('applied', { status: 'complete' }),
          plan('busy', { controlConsumers: ['pending-request'] }),
          plan('foreign', { guildId: '999' }),
        ] as never);
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('plans', actor);
      expect(review).toMatchObject({ total: 3, eligible: 1, protected: 2 });
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'applied' } as never, { $set: { status: 'planned' } });
      await connection.collection('archive_repair_runs').insertOne(plan('after-review') as never);
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        protected: 2,
        complete: true,
      });
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(4);
    }));

  it('rechecks execution eligibility and never erases newly applied plan journals', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(plan('plan') as never);
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('plans', actor);
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'plan' } as never, { $set: { status: 'partial' } });
      await connection
        .collection('archive_journals')
        .insertOne({ runId: 'plan', before: { content: 'recovery' } });
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 0,
        protected: 1,
        complete: true,
      });
      expect(await connection.collection('archive_journals').countDocuments()).toBe(1);
    }));

  it('binds review consent to actor, guild, channel, and exact message, and enforces expiry', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await control.submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      for (const field of ['userId', 'channelId', 'messageId'] as const)
        await expect(
          service.execute(review.reviewId, { ...actor, [field]: '999' }),
        ).rejects.toThrow('another actor');
      await expect(
        new ArchiveBulkDeletionService(connection, '999').execute(review.reviewId, actor),
      ).rejects.toThrow('Unknown');
      vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt + 1);
      await expect(service.execute(review.reviewId, actor)).rejects.toThrow('expired');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
    }));

  it('continues per-item failures, exposes only counts, and does not retry them on completed replay', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await control.submit('audit');
      await control.submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      const deletion = vi
        .spyOn(ArchiveControlService.prototype, 'deleteJob')
        .mockRejectedValueOnce(new Error('private credential content'));
      const result = await service.execute(review.reviewId, actor);
      expect(result).toMatchObject({ deleted: 1, failed: 1, complete: true });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(await service.execute(review.reviewId, actor)).toEqual(result);
      expect(deletion).toHaveBeenCalledTimes(2);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
    }));

  it('resumes an interrupted consumed snapshot after expiry without double-counting completed removals', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await control.submit('audit');
      await control.submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      const items = connection.collection('archive_bulk_deletion_items');
      const update = items.updateOne.bind(items);
      let interrupted = false;
      vi.spyOn(items, 'updateOne').mockImplementation(async (...args) => {
        if (!interrupted && !Array.isArray(args[1]) && args[1].$set?.['state'] === 'complete') {
          interrupted = true;
          throw new Error('outcome acknowledgement unavailable');
        }
        return update(...args);
      });
      await expect(service.execute(review.reviewId, actor)).rejects.toThrow(
        'outcome acknowledgement',
      );
      vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt + 1);
      expect(
        await new ArchiveBulkDeletionService(connection, '123').execute(review.reviewId, actor),
      ).toMatchObject({ deleted: 2, remaining: 0, complete: true });
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('rejects concurrent live executors and reports progress only after durable acceptance', async () =>
    withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await control.submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      let accepted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const work = service.execute(review.reviewId, actor, async () => {
        expect(
          await connection
            .collection('archive_bulk_deletions')
            .findOne({ _id: review.reviewId } as never),
        ).toMatchObject({ state: 'running', ownerId: ARCHIVE_PROCESS_ID });
        accepted();
        await wait;
      });
      await started;
      await expect(
        new ArchiveBulkDeletionService(connection, '123').execute(review.reviewId, actor),
      ).rejects.toThrow('already running');
      release();
      expect(await work).toMatchObject({ deleted: 1, complete: true });
    }));

  it('requires both client termination and server drainage before resuming a crashed foreign executor', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      await connection
        .collection('archive_bulk_deletions')
        .updateOne({ _id: review.reviewId } as never, {
          $set: {
            state: 'running',
            ownerId: `${hostname()}:12345:previous`,
            executionToken: 'previous',
          },
        });
      vi.spyOn(process, 'kill').mockReturnValue(true);
      await expect(service.execute(review.reviewId, actor)).rejects.toThrow('already running');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const admin = connection.db!.admin();
      vi.spyOn(connection.db!, 'admin').mockReturnValue(admin);
      const command = vi.spyOn(admin, 'command').mockResolvedValue({ inprog: [{ opid: 1 }] });
      await expect(service.execute(review.reviewId, actor)).rejects.toThrow('already running');
      command.mockResolvedValue({ inprog: [] });
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        complete: true,
      });
    }));

  it('captures a safe plan public reference before removing plan metadata', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(
        plan('plan', {
          publicMessage: { channelId: actor.channelId, messageId: '101' },
        }) as never,
      );
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('plans', actor);
      const published = vi.fn(async () => undefined);
      expect(await service.execute(review.reviewId, actor, undefined, published)).toMatchObject({
        deleted: 1,
      });
      expect(published).toHaveBeenCalledWith({
        kind: 'plans',
        id: 'plan',
        outcome: 'deleted',
        notification: { channelId: actor.channelId, messageId: '101' },
      });
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(0);
    }));
  it('retains a valid newly ready snapshot even when its review started more than a day ago', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      await connection
        .collection('archive_bulk_deletions')
        .updateOne({ _id: review.reviewId } as never, {
          $set: { createdAt: Date.now() - 172_800_000 },
        });
      await service.review('jobs', actor);
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        complete: true,
      });
    }));

  it('keeps an expired snapshot when execution wins the cleanup claim', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      const batches = connection.collection('archive_bulk_deletions');
      await batches.updateOne({ _id: review.reviewId } as never, {
        $set: { createdAt: Date.now() - 172_800_000, expiresAt: Date.now() - 1 },
      });
      const update = batches.updateOne.bind(batches);
      let accepted = false;
      vi.spyOn(batches, 'updateOne').mockImplementation(async (...args) => {
        if (!accepted && !Array.isArray(args[1]) && args[1].$set?.['state'] === 'expired') {
          accepted = true;
          await update({ _id: review.reviewId } as never, {
            $set: {
              state: 'running',
              ownerId: ARCHIVE_PROCESS_ID,
              executionToken: 'accepted-before-cleanup',
            },
          });
        }
        return update(...args);
      });
      await service.review('jobs', actor);
      expect(accepted).toBe(true);
      expect(await service.progress(review.reviewId, actor)).toMatchObject({ remaining: 1 });
      expect(await service.execute(review.reviewId, actor)).toMatchObject({
        deleted: 1,
        complete: true,
      });
    }));

  it('revokes consent before cleanup and retries interrupted cleanup without deleting jobs', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const review = await service.review('jobs', actor);
      const batches = connection.collection('archive_bulk_deletions');
      await batches.updateOne({ _id: review.reviewId } as never, {
        $set: { createdAt: Date.now() - 172_800_000, expiresAt: Date.now() - 1 },
      });
      const remove = vi
        .spyOn(connection.collection('archive_bulk_deletion_items'), 'deleteMany')
        .mockImplementationOnce(async () => {
          expect(await batches.findOne({ _id: review.reviewId } as never)).toHaveProperty(
            'state',
            'expired',
          );
          await expect(service.execute(review.reviewId, actor)).rejects.toThrow('expired');
          throw new Error('snapshot cleanup unavailable');
        });
      await expect(service.review('jobs', actor)).rejects.toThrow('snapshot cleanup');
      expect(await batches.findOne({ _id: review.reviewId } as never)).toHaveProperty(
        'state',
        'expired',
      );
      remove.mockRestore();
      await service.review('jobs', actor);
      expect(await batches.findOne({ _id: review.reviewId } as never)).toBeNull();
      expect(
        await connection
          .collection('archive_bulk_deletion_items')
          .countDocuments({ reviewId: review.reviewId }),
      ).toBe(0);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
    }));

  it('preserves old running snapshots and requires owner termination evidence for reviewing cleanup', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      const reviews = [];
      for (let index = 0; index < 4; index++) reviews.push(await service.review('jobs', actor));
      const [running, local, unknown, foreign] = reviews;
      const batches = connection.collection('archive_bulk_deletions');
      const old = Date.now() - 172_800_000;
      await batches.updateOne({ _id: running!.reviewId } as never, {
        $set: {
          state: 'running',
          createdAt: old,
          expiresAt: old,
          ownerId: ARCHIVE_PROCESS_ID,
          executionToken: 'interrupted',
        },
      });
      await batches.updateOne({ _id: local!.reviewId } as never, {
        $set: { state: 'reviewing', createdAt: old, ownerId: ARCHIVE_PROCESS_ID },
      });
      await batches.updateOne({ _id: unknown!.reviewId } as never, {
        $set: { state: 'reviewing', createdAt: old },
        $unset: { ownerId: '' },
      });
      await batches.updateOne({ _id: foreign!.reviewId } as never, {
        $set: { state: 'reviewing', createdAt: old, ownerId: `${hostname()}:12345:previous` },
      });
      await expect(service.execute(local!.reviewId, actor)).rejects.toThrow('expired');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const admin = connection.db!.admin();
      vi.spyOn(connection.db!, 'admin').mockReturnValue(admin);
      const command = vi.spyOn(admin, 'command').mockResolvedValue({ inprog: [{ opid: 1 }] });
      await service.review('jobs', actor);
      for (const review of reviews)
        expect(
          await connection
            .collection('archive_bulk_deletion_items')
            .countDocuments({ reviewId: review.reviewId }),
        ).toBe(1);
      command.mockResolvedValue({ inprog: [] });
      await service.review('jobs', actor);
      expect(await batches.findOne({ _id: foreign!.reviewId } as never)).toBeNull();
      for (const review of [running!, local!, unknown!])
        expect(
          await connection
            .collection('archive_bulk_deletion_items')
            .countDocuments({ reviewId: review.reviewId }),
        ).toBe(1);
      expect(await service.execute(running!.reviewId, actor)).toMatchObject({
        deleted: 1,
        complete: true,
      });
    }));

  it('marks failed review builds unusable and cleans old failed snapshot metadata without touching jobs', async () =>
    withFreshConnection(async (connection) => {
      await new ArchiveControlService(connection, '123').submit('audit');
      const service = new ArchiveBulkDeletionService(connection, '123');
      vi.spyOn(
        connection.collection('archive_bulk_deletion_items'),
        'insertMany',
      ).mockRejectedValueOnce(new Error('snapshot insertion unavailable'));
      await expect(service.review('jobs', actor)).rejects.toThrow('snapshot insertion');
      const failed = await connection
        .collection('archive_bulk_deletions')
        .findOne({ state: 'failed' });
      expect(failed).not.toBeNull();
      await expect(service.execute(failed!._id as unknown as string, actor)).rejects.toThrow(
        'expired',
      );
      await connection
        .collection('archive_bulk_deletions')
        .updateOne({ _id: failed!._id }, { $set: { createdAt: Date.now() - 172_800_000 } });
      await service.review('jobs', actor);
      expect(
        await connection.collection('archive_bulk_deletions').findOne({ _id: failed!._id }),
      ).toBeNull();
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
    }));
});
