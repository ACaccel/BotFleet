import { describe, expect, it, vi } from 'vitest';
import { mongo } from 'mongoose';
import { applyRepairBatch } from '../../../../src/plugins/message-backup/repair/apply-batch';
import { ArchiveRepairCancellation } from '../../../../src/plugins/message-backup/repair/cancellation';
import { repairHash } from '../../../../src/plugins/message-backup/repair/images';
import type { RepairDependencies } from '../../../../src/plugins/message-backup/repair/contracts';
import type { RepairDocument } from '../../../../src/plugins/message-backup/repair/contracts';
import type { RepairOperation } from '../../../../src/plugins/message-backup/repair/service';
import { withFreshConnection } from '../../helpers/mongo';

const dependencies: RepairDependencies = {
  policyHash: 'p',
  schemaHash: 's',
  classify: () => 'included',
  assertOwner: async () => undefined,
  ensureCapacity: async () => undefined,
  isCancelled: async () => false,
  withMaintenance: async (operation) => operation(),
  backfill: async () => ({ status: 'complete', counts: {}, issues: [] }),
};
const operation = (id: string, dependencies: string[] = []): RepairOperation => {
  const after = { _id: new mongo.ObjectId(), messageId: id, content: 'synthetic' };
  return {
    _id: id,
    runId: 'run',
    sequence: Number(id),
    collection: 'messages',
    documentId: after._id,
    before: null,
    after,
    beforeHash: repairHash(null),
    afterHash: repairHash(after),
    state: 'planned',
    reason: 'synthetic',
    dependencies,
  };
};
const cancellation = () => new ArchiveRepairCancellation('job', async () => false);

describe('standalone repair batch acknowledgements', () => {
  it('preserves a message scope across collection waves before unrelated later operations', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const first = operation('1');
      const second = { ...operation('2'), collection: 'archive_revisions' };
      second.after = { ...second.after!, messageId: '1' };
      second.afterHash = repairHash(second.after);
      const third = operation('3');
      await db
        .collection<RepairOperation>('archive_repair_operations')
        .insertMany([first, second, third]);
      const order: string[] = [];
      const result = await applyRepairBatch(
        db,
        [first, second, third],
        {
          ...dependencies,
          withCapacity: async (_bytes, commit) => {
            const current = await db
              .collection<RepairOperation>('archive_repair_operations')
              .find({ state: 'verified' })
              .toArray();
            order.push(
              current
                .map((record) => record._id)
                .sort()
                .join(','),
            );
            return commit();
          },
        },
        cancellation(),
      );
      expect(result.failure).toBeUndefined();
      expect(result.verified).toBe(3);
      expect(order).toEqual(['', '1,3']);
      expect(await db.collection('archive_revisions').countDocuments({})).toBe(1);
    });
  });

  it('acknowledges only a durable ordered prefix and safely replays the remaining operations', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const records = [operation('1'), operation('2'), operation('3')];
      const journal = db.collection<RepairOperation>('archive_repair_operations');
      await journal.insertMany(records);
      const messages = db.collection<RepairDocument>('messages');
      const collection = db.collection.bind(db);
      const bulk = messages.bulkWrite.bind(messages);
      const writing = vi
        .spyOn(messages, 'bulkWrite')
        .mockImplementation(async (writes, options) => {
          await bulk(writes.slice(0, 1), options);
          throw new Error('synthetic interruption after ordered prefix');
        });
      const resolving = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collection(name, options)) as typeof db.collection);
      try {
        const result = await applyRepairBatch(db, records, dependencies, cancellation());
        expect(result.verified).toBe(1);
        expect(String(result.failure)).toContain('ordered prefix');
        expect(
          (await journal.find({}).sort({ sequence: 1 }).toArray()).map((entry) => entry.state),
        ).toEqual(['verified', 'journaled', 'journaled']);
        expect(await messages.countDocuments({})).toBe(1);
      } finally {
        writing.mockRestore();
        resolving.mockRestore();
      }
      const remaining = await journal.find({ state: 'journaled' }).sort({ sequence: 1 }).toArray();
      const resumed = await applyRepairBatch(db, remaining, dependencies, cancellation());
      expect(resumed.failure).toBeUndefined();
      expect(resumed.verified).toBe(2);
      expect(await messages.countDocuments({})).toBe(3);
      expect(await journal.countDocuments({ state: 'verified' })).toBe(3);
    });
  });

  it('does not admit a dependent target after a zero-match journal verification acknowledgement', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const first = operation('1');
      const second = operation('2', ['1']);
      const journal = db.collection<RepairOperation>('archive_repair_operations');
      await journal.insertMany([first, second]);
      const collection = db.collection.bind(db);
      const update = journal.updateMany.bind(journal);
      const updating = vi.spyOn(journal, 'updateMany').mockImplementation(async (...args) => {
        if ((args[1] as { $set?: { state?: string } }).$set?.state === 'verified')
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        return update(...args);
      });
      const resolving = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'archive_repair_operations'
            ? journal
            : collection(name, options)) as typeof db.collection);
      try {
        const result = await applyRepairBatch(db, [first, second], dependencies, cancellation());
        expect(result.verified).toBe(0);
        expect(result.failure).toBeInstanceOf(Error);
        expect(String(result.failure)).toContain('acknowledgement failed');
        expect(await db.collection('messages').countDocuments({})).toBe(1);
        expect((await journal.findOne({ _id: '1' }))?.state).toBe('journaled');
        expect((await journal.findOne({ _id: '2' }))?.state).toBe('planned');
      } finally {
        updating.mockRestore();
        resolving.mockRestore();
      }
      const resumed = await applyRepairBatch(db, [first, second], dependencies, cancellation());
      expect(resumed.failure).toBeUndefined();
      expect(resumed.verified).toBe(2);
      expect(await db.collection('messages').countDocuments({})).toBe(2);
    });
  });

  it('rejects a stale before image before any target write or journal admission', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const current = operation('1');
      await db.collection<RepairOperation>('archive_repair_operations').insertOne(current);
      await db.collection<RepairDocument>('messages').insertOne({
        ...current.after!,
        content: 'external mutation',
      } as mongo.OptionalId<RepairDocument>);
      const result = await applyRepairBatch(db, [current], dependencies, cancellation());
      expect(result.verified).toBe(0);
      expect(String(result.failure)).toContain('Stale operation');
      expect((await db.collection('messages').findOne({}))?.['content']).toBe('external mutation');
      expect(
        (await db.collection<RepairOperation>('archive_repair_operations').findOne({}))?.state,
      ).toBe('planned');
    });
  });
});
