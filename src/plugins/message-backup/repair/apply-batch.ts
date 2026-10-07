import { mongo } from 'mongoose';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import type { RepairDependencies, RepairDocument } from './contracts';
import type { ArchiveRepairCancellation } from './cancellation';
import type { RepairOperation } from './service';
import { repairHash } from './images';

interface RepairBatchResult {
  readonly verified: number;
  readonly failure?: unknown;
}

const scope = (operation: RepairOperation): string => {
  const messageId = operation.after?.['messageId'] ?? operation.before?.['messageId'];
  return typeof messageId === 'string' && messageId.length > 0
    ? `message:${messageId}`
    : `${operation.collection}:${repairHash({ documentId: operation.documentId })}`;
};

export const readRepairTargets = async (
  database: mongo.Db,
  operations: readonly RepairOperation[],
): Promise<Map<string, RepairDocument | null>> => {
  const result = new Map<string, RepairDocument | null>();
  const collections = [...new Set(operations.map((operation) => operation.collection))];
  let bytes = 0;
  for (const name of collections) {
    const selected = operations.filter((operation) => operation.collection === name);
    const byId = new Map<string, RepairDocument>();
    const cursor = database
      .collection<RepairDocument>(name)
      .find({
        _id: { $in: selected.map((operation) => operation.documentId) },
      } as unknown as mongo.Filter<RepairDocument>)
      .batchSize(Math.min(10, selected.length));
    try {
      for await (const document of cursor) {
        bytes += mongo.BSON.calculateObjectSize(document);
        if (bytes > ARCHIVE_LIMITS.pipelineBytes)
          throw new RangeError('Repair observations exceed memory budget');
        byId.set(repairHash({ documentId: document._id }), document);
      }
    } finally {
      await cursor.close();
    }
    for (const operation of selected)
      result.set(operation._id, byId.get(repairHash({ documentId: operation.documentId })) ?? null);
  }
  return result;
};

/** Only independent message scopes with verified dependencies enter each standalone bulk. */
export const applyRepairBatch = async (
  database: mongo.Db,
  batch: readonly RepairOperation[],
  dependencies: RepairDependencies,
  cancellation: ArchiveRepairCancellation,
): Promise<RepairBatchResult> => {
  const journal = database.collection<RepairOperation>('archive_repair_operations');
  const dependencyIds = [...new Set(batch.flatMap((operation) => operation.dependencies))];
  const dependencyStates =
    dependencyIds.length === 0
      ? []
      : await journal
          .find({ _id: { $in: dependencyIds }, state: 'verified' }, { projection: { _id: 1 } })
          .toArray();
  const verified = new Set(dependencyStates.map((operation) => operation._id));
  const remaining = [...batch];
  let completed = 0;
  try {
    while (remaining.length > 0) {
      await cancellation.checkpoint();
      await dependencies.assertOwner();
      await cancellation.checkpoint();
      const occupied = new Set<string>();
      const waveCollection = remaining.find((operation) =>
        operation.dependencies.every((id) => verified.has(id)),
      )?.collection;
      const wave = remaining.filter((operation) => {
        const key = scope(operation);
        if (occupied.has(key)) return false;
        occupied.add(key);
        if (
          operation.collection !== waveCollection ||
          !operation.dependencies.every((id) => verified.has(id))
        )
          return false;
        return true;
      });
      if (wave.length === 0)
        return {
          verified: completed,
          failure: new Error('Repair batch has unverified or cyclic dependencies'),
        };
      const current = await readRepairTargets(database, wave);
      for (const operation of wave) {
        const hash = repairHash(current.get(operation._id) ?? null);
        if (hash !== operation.beforeHash && hash !== operation.afterHash)
          return {
            verified: completed,
            failure: new Error(`Stale operation ${operation._id}; replan required`),
          };
      }
      const bytes = wave.reduce(
        (sum, operation) =>
          sum + (operation.after === null ? 0 : mongo.BSON.calculateObjectSize(operation.after)),
        0,
      );
      const commit = async (): Promise<RepairBatchResult> => {
        await cancellation.checkpoint();
        const staged = await journal.updateMany(
          {
            _id: { $in: wave.map((operation) => operation._id) },
            state: { $in: ['planned', 'journaled'] },
          },
          { $set: { state: 'journaled' } },
          { writeConcern: { w: 'majority', j: true } },
        );
        if (!staged.acknowledged || staged.matchedCount !== wave.length)
          return {
            verified: 0,
            failure: new Error('Repair journal changed before batch mutation'),
          };
        let failure: unknown;
        const collections = [...new Set(wave.map((operation) => operation.collection))];
        for (const name of collections) {
          await cancellation.checkpoint();
          const writing = wave.filter(
            (operation) =>
              operation.collection === name &&
              repairHash(current.get(operation._id) ?? null) !== operation.afterHash,
          );
          const writes: mongo.AnyBulkWriteOperation<RepairDocument>[] = writing.map(
            (operation): mongo.AnyBulkWriteOperation<RepairDocument> => {
              if (operation.before === null) {
                if (operation.after === null) throw new Error('Empty repair operation');
                return {
                  insertOne: { document: operation.after as mongo.OptionalId<RepairDocument> },
                };
              }
              const filter = {
                _id: operation.documentId,
                $expr: { $eq: ['$$ROOT', { $literal: operation.before }] },
              } as mongo.Filter<RepairDocument>;
              return operation.after === null
                ? { deleteOne: { filter } }
                : { replaceOne: { filter, replacement: operation.after } };
            },
          );
          try {
            if (writes.length > 0)
              await database.collection<RepairDocument>(name).bulkWrite(writes, {
                ordered: true,
                writeConcern: { w: 'majority', j: true },
              });
          } catch (error) {
            failure = error;
            if (
              error instanceof mongo.MongoBulkWriteError &&
              error.result.getWriteConcernError() !== undefined
            )
              return { verified: 0, failure };
            break;
          }
        }
        // Cancellation after an issued bulk finishes its readback and journal acknowledgement.
        const after = await readRepairTargets(database, wave);
        const successes: string[] = [];
        const conflicts: string[] = [];
        for (const operation of wave) {
          if (repairHash(after.get(operation._id) ?? null) === operation.afterHash)
            successes.push(operation._id);
          else conflicts.push(operation._id);
        }
        if (successes.length > 0) {
          const acknowledged = await journal.updateMany(
            { _id: { $in: successes }, state: 'journaled' },
            { $set: { state: 'verified' } },
            { writeConcern: { w: 'majority', j: true } },
          );
          if (!acknowledged.acknowledged || acknowledged.matchedCount !== successes.length)
            return {
              verified: 0,
              failure: new Error('Repair batch journal acknowledgement failed'),
            };
        }
        if (conflicts.length > 0 && failure === undefined)
          await journal.updateMany(
            { _id: { $in: conflicts }, state: 'journaled' },
            { $set: { state: 'conflict' } },
            { writeConcern: { w: 'majority', j: true } },
          );
        for (const id of successes) verified.add(id);
        return {
          verified: successes.length,
          ...(failure === undefined && conflicts.length === 0
            ? {}
            : {
                failure: failure ?? new Error('Repair batch after-image verification failed'),
              }),
        };
      };
      const result =
        dependencies.withCapacity === undefined
          ? await (async () => {
              await dependencies.ensureCapacity(bytes);
              return commit();
            })()
          : await dependencies.withCapacity(bytes, commit);
      completed += result.verified;
      if (result.failure !== undefined) return { verified: completed, failure: result.failure };
      const completedIds = new Set(wave.map((operation) => operation._id));
      for (let index = remaining.length - 1; index >= 0; index -= 1)
        if (completedIds.has(remaining[index]!._id)) remaining.splice(index, 1);
    }
    return { verified: completed };
  } catch (failure) {
    return { verified: completed, failure };
  }
};
