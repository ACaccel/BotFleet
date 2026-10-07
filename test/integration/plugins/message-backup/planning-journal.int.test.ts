import { describe, expect, it, vi } from 'vitest';
import { mongo } from 'mongoose';
import { ArchiveRepairPlanningJournal } from '../../../../src/plugins/message-backup/repair/planning-journal';
import { ArchiveRepairCancellation } from '../../../../src/plugins/message-backup/repair/cancellation';
import { repairHash } from '../../../../src/plugins/message-backup/repair/images';
import type { RepairDependencies } from '../../../../src/plugins/message-backup/repair/contracts';
import type {
  RepairOperation,
  RepairRun,
} from '../../../../src/plugins/message-backup/repair/service';
import { withFreshConnection } from '../../helpers/mongo';

const dependencies = (patch: Partial<RepairDependencies> = {}): RepairDependencies => ({
  policyHash: 'p',
  schemaHash: 's',
  classify: () => 'included',
  assertOwner: async () => undefined,
  ensureCapacity: async () => undefined,
  isCancelled: async () => false,
  withMaintenance: async (operation) => operation(),
  backfill: async () => ({ status: 'complete', counts: {}, issues: [] }),
  ...patch,
});
const run = (): RepairRun => ({
  _id: 'journal-run',
  guildId: '1',
  policyHash: 'p',
  schemaHash: 's',
  cutoff: 1,
  createdAt: 1,
  validUntil: 10000,
  status: 'enriching',
  operations: 0,
  unresolved: 0,
  journalBytes: 0,
  issues: [],
});
const operation = (id: string, content = 'synthetic'): RepairOperation => {
  const after = { _id: new mongo.ObjectId(), messageId: id, content };
  const beforeHash = repairHash(null);
  const afterHash = repairHash(after);
  return {
    _id: `journal-run:${repairHash({ collection: 'messages', documentId: after._id, beforeHash, afterHash, reason: 'synthetic' })}`,
    runId: 'journal-run',
    sequence: 0,
    collection: 'messages',
    documentId: after._id,
    before: null,
    after,
    beforeHash,
    afterHash,
    state: 'planned',
    reason: 'synthetic',
    dependencies: [],
  };
};
const cancellation = () => new ArchiveRepairCancellation('job', async () => false);

describe('bounded repair journal planning', () => {
  it('deduplicates stages and reserves contiguous durable sequences for whole batches', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const current = run();
      await db.collection<RepairRun>('archive_repair_runs').insertOne(current);
      await db
        .collection('archive_repair_operations')
        .createIndex({ runId: 1, sequence: 1 }, { unique: true });
      const admission = vi.fn().mockResolvedValue(undefined);
      const planner = new ArchiveRepairPlanningJournal(
        db,
        current,
        dependencies({ ensureCapacity: admission, planningBatchDocuments: 2 }),
        cancellation(),
      );
      const first = operation('11');
      await planner.stage(first);
      await planner.stage(first);
      expect(await db.collection('archive_repair_operations').countDocuments({})).toBe(0);
      await planner.stage(operation('12'));
      const records = await db
        .collection('archive_repair_operations')
        .find({})
        .sort({ sequence: 1 })
        .toArray();
      expect(records.map((record) => record['sequence'])).toEqual([0, 1]);
      expect(current.operations).toBe(2);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(
        (await db.collection<RepairRun>('archive_repair_runs').findOne({ _id: current._id }))
          ?.sequenceHighWatermark,
      ).toBe(2);
    });
  });

  it('reconstructs counters after a bulk commit outlives its run checkpoint', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const current = run();
      const runs = db.collection<RepairRun>('archive_repair_runs');
      await runs.insertOne(current);
      const collection = db.collection.bind(db);
      const update = runs.updateOne.bind(runs);
      let updates = 0;
      const updating = vi.spyOn(runs, 'updateOne').mockImplementation(async (...args) => {
        updates += 1;
        if (updates === 2) throw new Error('crash after journal bulk');
        return update(...args);
      });
      const resolving = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'archive_repair_runs'
            ? runs
            : collection(name, options)) as typeof db.collection);
      const first = operation('11');
      try {
        const planner = new ArchiveRepairPlanningJournal(
          db,
          current,
          dependencies(),
          cancellation(),
        );
        await planner.stage(first);
        await expect(planner.flush()).rejects.toThrow('crash after journal bulk');
      } finally {
        updating.mockRestore();
        resolving.mockRestore();
      }
      const stale = await runs.findOne({ _id: current._id });
      expect(stale?.operations).toBe(0);
      expect(stale?.sequenceHighWatermark).toBe(1);
      const recovered = new ArchiveRepairPlanningJournal(
        db,
        stale!,
        dependencies(),
        cancellation(),
      );
      await recovered.stage(first);
      await recovered.flush();
      expect(stale?.operations).toBe(1);
      expect(stale?.journalBytes).toBe(
        mongo.BSON.calculateObjectSize(
          (await db.collection('archive_repair_operations').findOne({}))!,
        ),
      );
      await recovered.stage(operation('12'));
      await recovered.flush();
      expect(stale?.operations).toBe(2);
      expect(
        (
          await db.collection('archive_repair_operations').find({}).sort({ sequence: 1 }).toArray()
        ).map((record) => record['sequence']),
      ).toEqual([0, 1]);
    });
  });

  it('counts a partially committed prefix and never reuses a reserved sequence after restart', async () => {
    await withFreshConnection(async (connection) => {
      const db = connection.db!;
      const current = run();
      await db.collection<RepairRun>('archive_repair_runs').insertOne(current);
      const operations = db.collection<RepairOperation>('archive_repair_operations');
      const collection = db.collection.bind(db);
      const insert = operations.insertMany.bind(operations);
      const inserting = vi
        .spyOn(operations, 'insertMany')
        .mockImplementation(async (records, options) => {
          await insert(records.slice(0, 1), options);
          throw new Error('synthetic partial bulk failure');
        });
      const resolving = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'archive_repair_operations'
            ? operations
            : collection(name, options)) as typeof db.collection);
      const second = operation('12');
      try {
        const planner = new ArchiveRepairPlanningJournal(
          db,
          current,
          dependencies(),
          cancellation(),
        );
        await planner.stage(operation('11'));
        await planner.stage(second);
        await expect(planner.flush()).rejects.toThrow('partial bulk failure');
        expect(current.operations).toBe(1);
      } finally {
        inserting.mockRestore();
        resolving.mockRestore();
      }
      const persisted = (await db
        .collection<RepairRun>('archive_repair_runs')
        .findOne({ _id: current._id }))!;
      const recovered = new ArchiveRepairPlanningJournal(
        db,
        persisted,
        dependencies(),
        cancellation(),
      );
      await recovered.stage(second);
      await recovered.flush();
      expect(persisted.operations).toBe(2);
      expect(
        (await operations.find({}).sort({ sequence: 1 }).toArray()).map(
          (record) => record.sequence,
        ),
      ).toEqual([0, 2]);
      expect(persisted.sequenceHighWatermark).toBe(3);
    });
  });

  it('persists a six MiB recovery image as a singleton beyond the batch soft limit', async () => {
    await withFreshConnection(async (connection) => {
      const current = run();
      await connection.db!.collection<RepairRun>('archive_repair_runs').insertOne(current);
      const admission = vi.fn().mockResolvedValue(undefined);
      const planner = new ArchiveRepairPlanningJournal(
        connection.db!,
        current,
        dependencies({ ensureCapacity: admission }),
        cancellation(),
      );
      const large = operation('11', 'x'.repeat(6 * 1024 * 1024));
      await planner.stage(large);
      expect(current.operations).toBe(1);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(await connection.collection('archive_repair_operations').countDocuments({})).toBe(1);
      expect(
        (await connection.collection('archive_repair_operations').findOne({}))?.['after'],
      ).toEqual(large.after);
      expect(await connection.collection('messages').countDocuments({})).toBe(0);
      await planner.stage(operation('12'));
      await planner.flush();
      expect(current.operations).toBe(2);
      expect(admission).toHaveBeenCalledTimes(2);
    });
  });

  it('fails oversized recovery images before any source mutation or journal admission', async () => {
    await withFreshConnection(async (connection) => {
      const current = run();
      await connection.db!.collection<RepairRun>('archive_repair_runs').insertOne(current);
      const admission = vi.fn().mockResolvedValue(undefined);
      const planner = new ArchiveRepairPlanningJournal(
        connection.db!,
        current,
        dependencies({ planningBatchBytes: 1024, ensureCapacity: admission }),
        cancellation(),
      );
      await expect(planner.stage(operation('11', 'x'.repeat(15 * 1024 * 1024)))).rejects.toThrow(
        'source left unchanged',
      );
      expect(admission).not.toHaveBeenCalled();
      expect(await connection.collection('archive_repair_operations').countDocuments({})).toBe(0);
      expect(await connection.collection('messages').countDocuments({})).toBe(0);
    });
  });
});
