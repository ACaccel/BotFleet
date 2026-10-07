import { mongo } from 'mongoose';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import type { RepairDependencies } from './contracts';
import type { ArchiveRepairCancellation } from './cancellation';
import type { RepairOperation, RepairRun } from './service';

/** One owner reserves durable sequence ranges before inserting bounded before-image batches. */
export class ArchiveRepairPlanningJournal {
  private pending: RepairOperation[] = [];
  private pendingBytes = 0;
  private readonly pendingIds = new Set<string>();
  private nextSequence: number | undefined;
  private readonly maximumDocuments: number;
  private readonly maximumBytes: number;

  constructor(
    private readonly database: mongo.Db,
    readonly run: RepairRun,
    private readonly dependencies: RepairDependencies,
    private readonly cancellation: ArchiveRepairCancellation,
  ) {
    this.maximumDocuments = dependencies.planningBatchDocuments ?? ARCHIVE_LIMITS.batchDocuments;
    this.maximumBytes = dependencies.planningBatchBytes ?? ARCHIVE_LIMITS.batchBytes;
    if (
      !Number.isSafeInteger(this.maximumDocuments) ||
      this.maximumDocuments < 1 ||
      this.maximumDocuments > 1000 ||
      !Number.isSafeInteger(this.maximumBytes) ||
      this.maximumBytes < 1024 ||
      this.maximumBytes > ARCHIVE_LIMITS.pipelineBytes
    )
      throw new TypeError('Invalid repair planning batch limits');
  }

  async stage(operation: RepairOperation): Promise<string> {
    await this.cancellation.checkpoint();
    if (this.pendingIds.has(operation._id)) return operation._id;
    const bytes = mongo.BSON.calculateObjectSize(operation);
    if (bytes > 15 * 1024 * 1024 || bytes > ARCHIVE_LIMITS.pipelineBytes)
      throw new RangeError(
        'Repair recovery image exceeds batch byte budget; source left unchanged',
      );
    if (
      this.pending.length >= this.maximumDocuments ||
      this.pendingBytes + bytes > this.maximumBytes
    )
      await this.flush();
    this.pending.push(operation);
    this.pendingIds.add(operation._id);
    this.pendingBytes += bytes;
    if (this.pending.length >= this.maximumDocuments || this.pendingBytes >= this.maximumBytes)
      await this.flush();
    return operation._id;
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    await this.cancellation.checkpoint();
    await this.dependencies.assertOwner();
    const operations = this.database.collection<RepairOperation>('archive_repair_operations');
    const pending = this.pending;
    const existing = await operations
      .find(
        { _id: { $in: pending.map((operation) => operation._id) } },
        { projection: { _id: 1, sequence: 1 } },
      )
      .toArray();
    const ids = new Set(existing.map((operation) => operation._id));
    const inserting = pending.filter((operation) => !ids.has(operation._id));
    if (this.nextSequence === undefined) {
      const totals = await operations
        .aggregate<{
          operations: number;
          bytes: number;
        }>([
          { $match: { runId: this.run._id } },
          {
            $group: {
              _id: null,
              operations: { $sum: 1 },
              bytes: { $sum: { $bsonSize: '$$ROOT' } },
            },
          },
        ])
        .next();
      // A preceding process may have inserted its batch before its run checkpoint failed.
      this.run.operations = totals?.operations ?? 0;
      this.run.journalBytes = totals?.bytes ?? 0;
      const latest = await operations
        .find({ runId: this.run._id }, { projection: { sequence: 1 } })
        .sort({ sequence: -1 })
        .limit(1)
        .next();
      this.nextSequence = Math.max(
        this.run.sequenceHighWatermark ?? 0,
        this.run.operations,
        (latest?.sequence ?? -1) + 1,
      );
    }
    for (const operation of inserting) operation.sequence = this.nextSequence++;
    for (const operation of existing)
      this.nextSequence = Math.max(this.nextSequence, operation.sequence + 1);
    const bytes = inserting.reduce(
      (sum, operation) => sum + mongo.BSON.calculateObjectSize(operation),
      0,
    );
    const persist = async (): Promise<void> => {
      await this.cancellation.checkpoint();
      const runs = this.database.collection<RepairRun>('archive_repair_runs');
      const reservation = await runs.updateOne(
        { _id: this.run._id, status: { $in: ['planning', 'enriching'] } },
        { $max: { sequenceHighWatermark: this.nextSequence } },
        { writeConcern: { w: 'majority', j: true } },
      );
      if (!reservation.acknowledged || reservation.matchedCount !== 1)
        throw new Error('Repair journal sequencing authority lost');
      this.run.sequenceHighWatermark = this.nextSequence;
      let persisted = inserting;
      let failure: unknown;
      try {
        if (inserting.length > 0) {
          await this.cancellation.checkpoint();
          await operations.insertMany(inserting, {
            ordered: true,
            writeConcern: { w: 'majority', j: true },
          });
        }
      } catch (error) {
        failure = error;
        // A standalone bulk can commit a prefix before failing. Count only durable records.
        persisted = await operations
          .find({ _id: { $in: inserting.map((operation) => operation._id) } })
          .toArray();
      }
      this.run.operations += persisted.length;
      this.run.journalBytes += persisted.reduce(
        (sum, operation) => sum + mongo.BSON.calculateObjectSize(operation),
        0,
      );
      this.pending = [];
      this.pendingIds.clear();
      this.pendingBytes = 0;
      const checkpoint = await runs.updateOne(
        { _id: this.run._id },
        { $set: { operations: this.run.operations, journalBytes: this.run.journalBytes } },
        { writeConcern: { w: 'majority', j: true } },
      );
      if (!checkpoint.acknowledged || checkpoint.matchedCount !== 1)
        throw new Error('Repair journal counter checkpoint failed');
      if (failure !== undefined) throw failure;
    };
    if (this.dependencies.withCapacity !== undefined)
      await this.dependencies.withCapacity(bytes, persist);
    else {
      await this.dependencies.ensureCapacity(bytes);
      await persist();
    }
  }
}
