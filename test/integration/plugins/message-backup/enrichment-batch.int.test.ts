import { mongo } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type {
  RepairDependencies,
  RepairDocument,
  RepairMutation,
  RepairRequest,
} from '../../../../src/plugins/message-backup/repair/contracts';
import {
  ArchiveRepairService,
  REPAIR_OPERATIONS,
} from '../../../../src/plugins/message-backup/repair/service';
import { withFreshConnection } from '../../helpers/mongo';

const request = (command: RepairRequest['command'], runId?: string): RepairRequest => ({
  jobId: `batch-${command}`,
  guildId: '123',
  command,
  options: {},
  ...(runId === undefined ? {} : { runId }),
});
const dependencies = (patch: Partial<RepairDependencies> = {}): RepairDependencies => ({
  policyHash: 'synthetic-policy',
  schemaHash: '2',
  classify: () => 'included',
  assertOwner: async () => undefined,
  ensureCapacity: async () => undefined,
  withMaintenance: async (operation) => operation(),
  isCancelled: async () => false,
  backfill: async () => ({ status: 'complete', counts: {}, issues: [] }),
  ...patch,
});
const document = (id: number): RepairDocument & { _id: mongo.ObjectId } => ({
  _id: new mongo.ObjectId(),
  messageId: String(id),
  channelId: '222',
  content: 'before',
  timestamp: 123,
  userId: '333',
  authorKind: 'human',
  schemaVersion: 2,
});
const update = (before: RepairDocument): RepairMutation => ({
  collection: 'messages',
  before,
  after: { ...before, content: 'after' },
  reason: 'message-snapshot',
});

describe('durable enrichment batches', () => {
  it('journals one batch before ordered waves and restores messages while retaining observed revisions', async () =>
    withFreshConnection(async (connection) => {
      const db = connection.db!;
      const before = Array.from({ length: 12 }, (_, index) => document(index + 1));
      await db.collection('messages').insertMany(before);
      const prepared: RepairMutation[] = before.flatMap((entry) => [
        {
          collection: 'archive_revisions',
          before: null,
          after: { ...entry, _id: new mongo.ObjectId() },
          reason: 'message-revision',
        },
        update(entry),
      ]);
      const journal = db.collection(REPAIR_OPERATIONS);
      const messages = db.collection('messages');
      const revisions = db.collection('archive_revisions');
      const collect = db.collection.bind(db);
      const insertion = journal.insertMany.bind(journal);
      const stage = vi.spyOn(journal, 'insertMany').mockImplementation(async (entries, options) => {
        expect(await messages.countDocuments({ content: 'after' })).toBe(0);
        expect(options?.writeConcern).toEqual({ w: 'majority', j: true });
        return insertion(entries, options);
      });
      const messageBulk = messages.bulkWrite.bind(messages);
      const writes = vi
        .spyOn(messages, 'bulkWrite')
        .mockImplementation(async (entries, options) => {
          expect(await journal.countDocuments({})).toBe(24);
          expect(await revisions.countDocuments({})).toBe(12);
          return messageBulk(entries, options);
        });
      const collections = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === REPAIR_OPERATIONS
            ? journal
            : name === 'messages'
              ? messages
              : name === 'archive_revisions'
                ? revisions
                : collect(name, options)) as typeof db.collection);
      const timing = vi.fn();
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          onEnrichmentBatch: timing,
          backfill: async (context) => {
            await context.applyMutations!(prepared);
            expect(await messages.countDocuments({ content: 'after' })).toBe(12);
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      try {
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
        expect(stage).toHaveBeenCalledTimes(1);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(timing).toHaveBeenCalledTimes(1);
        expect(timing).toHaveBeenCalledWith({
          operations: 24,
          verified: 24,
          journalMs: expect.any(Number),
          writeVerifyMs: expect.any(Number),
        });
        expect(timing.mock.calls[0]![0].journalMs).toBeGreaterThanOrEqual(0);
        expect(timing.mock.calls[0]![0].writeVerifyMs).toBeGreaterThanOrEqual(0);
        const operations = await journal.find({}).sort({ sequence: 1 }).toArray();
        expect(operations).toHaveLength(24);
        for (let index = 1; index < operations.length; index += 2)
          expect(operations[index]!.dependencies).toEqual([operations[index - 1]!._id]);
        writes.mockRestore();
        stage.mockRestore();
        expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
        expect(await messages.find({}).sort({ messageId: 1 }).toArray()).toEqual(
          [...before].sort((a, b) => String(a.messageId).localeCompare(String(b.messageId))),
        );
        expect(await revisions.countDocuments({})).toBe(12);
        expect(
          await journal.countDocuments({ retainedObservedVersion: true, state: 'rolled-back' }),
        ).toBe(12);
      } finally {
        collections.mockRestore();
        writes.mockRestore();
        stage.mockRestore();
      }
    }));

  it('rechecks source evidence after a revision wave before publishing the message wave', async () =>
    withFreshConnection(async (connection) => {
      const before = document(1);
      await connection.collection('messages').insertOne(before);
      let valid = true;
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          withCapacity: async (_bytes, commit) => {
            if ((await connection.collection('archive_revisions').countDocuments({})) > 0)
              valid = false;
            return commit();
          },
          backfill: async (context) => {
            await context.applyMutations!(
              [
                {
                  collection: 'archive_revisions',
                  before: null,
                  after: { ...before, _id: new mongo.ObjectId() },
                  reason: 'message-revision',
                },
                update(before),
              ],
              () => {
                if (!valid) throw new Error('Synthetic source invalidation');
              },
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
      expect(await connection.collection('messages').findOne({ messageId: '1' })).toEqual(before);
      expect(
        (
          await connection.collection(REPAIR_OPERATIONS).find({}).sort({ sequence: 1 }).toArray()
        ).map((entry) => entry.state),
      ).toEqual(['verified', 'journaled']);
    }));

  it('keeps legacy journals sequential and preserves repeated-document read-your-writes', async () =>
    withFreshConnection(async (connection) => {
      const before = document(1);
      await connection.collection('messages').insertOne(before);
      const first = update(before);
      const second: RepairMutation = {
        ...first,
        before: first.after,
        after: { ...first.after!, content: 'final' },
        reason: 'second-snapshot',
      };
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutations!([first, second]);
            expect(
              await connection.collection('messages').findOne({ messageId: '1' }),
            ).toMatchObject({ content: 'final' });
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: plan.runId } as never, { $set: { journalVersion: 1, schemaHash: '2' } });
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(
        await connection.collection(REPAIR_OPERATIONS).countDocuments({ state: 'verified' }),
      ).toBe(2);
      expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').findOne({ messageId: '1' })).toEqual(before);
    }));

  it('recovers an ordered partial write and deduplicates replayed batch operations', async () =>
    withFreshConnection(async (connection) => {
      const db = connection.db!;
      const before = [document(1), document(2), document(3)];
      await db.collection('messages').insertMany(before);
      const prepared = before.map(update);
      const messages = db.collection('messages');
      const bulk = messages.bulkWrite.bind(messages);
      const collect = db.collection.bind(db);
      const writing = vi
        .spyOn(messages, 'bulkWrite')
        .mockImplementation(async (entries, options) => {
          await bulk(entries.slice(0, 1), options);
          throw new Error('Synthetic interruption after durable prefix');
        });
      const collections = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collect(name, options)) as typeof db.collection);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutations!(prepared);
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      try {
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
        const journal = db.collection(REPAIR_OPERATIONS);
        expect(
          (await journal.find({}).sort({ sequence: 1 }).toArray()).map((entry) => entry.state),
        ).toEqual(['verified', 'journaled', 'journaled']);
        writing.mockRestore();
        expect((await service.execute(request('resume', plan.runId))).status).toBe('complete');
        expect(await journal.countDocuments({})).toBe(3);
        expect(await journal.countDocuments({ state: 'verified' })).toBe(3);
        expect(await messages.countDocuments({ content: 'after' })).toBe(3);
        expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
        expect(await messages.countDocuments({ content: 'before' })).toBe(3);
      } finally {
        writing.mockRestore();
        collections.mockRestore();
      }
    }));

  it('preserves a concurrent edit and verifies only successful siblings in a batch', async () =>
    withFreshConnection(async (connection) => {
      const db = connection.db!;
      const before = [document(1), document(2)];
      await db.collection('messages').insertMany(before);
      const messages = db.collection('messages');
      const bulk = messages.bulkWrite.bind(messages);
      const collect = db.collection.bind(db);
      const writing = vi
        .spyOn(messages, 'bulkWrite')
        .mockImplementation(async (entries, options) => {
          await messages.updateOne(
            { _id: before[1]!._id as mongo.ObjectId },
            { $set: { content: 'concurrent edit' } },
          );
          return bulk(entries, options);
        });
      const collections = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collect(name, options)) as typeof db.collection);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutations!(before.map(update));
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      try {
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
        expect(
          (await db.collection(REPAIR_OPERATIONS).find({}).sort({ sequence: 1 }).toArray()).map(
            (entry) => entry.state,
          ),
        ).toEqual(['verified', 'conflict']);
        expect(await messages.findOne({ messageId: '2' })).toMatchObject({
          content: 'concurrent edit',
        });
        writing.mockRestore();
        const rollback = await service.execute(request('rollback', plan.runId));
        expect(rollback.status).toBe('partial');
        expect(rollback.counts['conflicts']).toBe(1);
        expect(await messages.findOne({ messageId: '1' })).toMatchObject({ content: 'before' });
        expect(await messages.findOne({ messageId: '2' })).toMatchObject({
          content: 'concurrent edit',
        });
      } finally {
        writing.mockRestore();
        collections.mockRestore();
      }
    }));

  it('acknowledges an issued bulk before cancellation and rejects oversized batches before staging', async () =>
    withFreshConnection(async (connection) => {
      const db = connection.db!;
      const before = [document(1), document(2)];
      await db.collection('messages').insertMany(before);
      const controller = new AbortController();
      const messages = db.collection('messages');
      const bulk = messages.bulkWrite.bind(messages);
      const collect = db.collection.bind(db);
      const writing = vi
        .spyOn(messages, 'bulkWrite')
        .mockImplementation(async (entries, options) => {
          const result = await bulk(entries, options);
          controller.abort();
          return result;
        });
      const collections = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collect(name, options)) as typeof db.collection);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          signal: controller.signal,
          backfill: async (context) => {
            await expect(
              context.applyMutations!(Array.from({ length: 501 }, () => update(before[0]!))),
            ).rejects.toThrow('document limit');
            await expect(
              context.applyMutations!([
                { ...update(before[0]!), reason: 'x'.repeat(4 * 1024 * 1024) },
              ]),
            ).rejects.toThrow('byte limit');
            expect(await db.collection(REPAIR_OPERATIONS).countDocuments({})).toBe(0);
            await context.applyMutations!(before.map(update));
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      try {
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('cancelled');
        expect(await db.collection(REPAIR_OPERATIONS).countDocuments({ state: 'verified' })).toBe(
          2,
        );
        expect(await messages.countDocuments({ content: 'after' })).toBe(2);
        writing.mockRestore();
        const resumed = new ArchiveRepairService(connection, dependencies());
        expect((await resumed.execute(request('resume', plan.runId))).status).toBe('complete');
        expect((await resumed.execute(request('rollback', plan.runId))).status).toBe('complete');
        expect(await messages.countDocuments({ content: 'before' })).toBe(2);
      } finally {
        writing.mockRestore();
        collections.mockRestore();
      }
    }));
});
