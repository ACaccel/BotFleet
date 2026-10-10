import { mongo, type Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type {
  RepairDependencies,
  RepairRequest,
} from '../../../../src/plugins/message-backup/repair/contracts';
import {
  ArchiveRepairService,
  REPAIR_OPERATIONS,
  REPAIR_RUNS,
} from '../../../../src/plugins/message-backup/repair/service';
import { ArchiveControlService } from '../../../../src/infra/archive/control';

import { withFreshConnection } from '../../helpers/mongo';

const request = (command: RepairRequest['command'], runId?: string): RepairRequest => ({
  jobId: 'synthetic-job',
  guildId: '123',
  command,
  options: {},
  ...(runId ? { runId } : {}),
});
const dependencies = (patch: Partial<RepairDependencies> = {}): RepairDependencies => ({
  policyHash: 'synthetic-policy',
  schemaHash: '2',
  classify: (document) =>
    document['authorKind'] === 'bot'
      ? 'excluded'
      : document['authorKind'] === 'human'
        ? 'included'
        : 'unknown',
  assertOwner: async () => undefined,
  ensureCapacity: async () => undefined,
  withMaintenance: async (operation) => operation(),
  isCancelled: async () => false,
  backfill: async () => ({ status: 'complete', counts: {}, issues: [] }),
  ...patch,
});
const seed = async (
  connection: Connection,
  documents: Record<string, unknown>[],
): Promise<void> => {
  await connection.collection('messages').insertMany(documents);
};
const message = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: new mongo.ObjectId(),
  messageId: '111',
  channelId: '222',
  content: 'synthetic content',
  timestamp: 123,
  userId: '333',
  authorKind: 'human',
  ...patch,
});

describe('msg-archive repair state machine', () => {
  it.each([
    ['replace', 'object-id'],
    ['replace', 'string'],
    ['replace', 'document'],
    ['delete', 'object-id'],
    ['delete', 'string'],
    ['delete', 'document'],
  ] as const)('uses the ID index for enrichment %s with a %s ID', async (mutation, idKind) => {
    await withFreshConnection(async (connection) => {
      const documentId =
        idKind === 'object-id'
          ? new mongo.ObjectId()
          : idKind === 'string'
            ? '$synthetic-id'
            : { key: 'synthetic-id' };
      await seed(connection, [
        ...Array.from({ length: 64 }, (_, index) => message({ messageId: String(1000 + index) })),
        message({ _id: documentId }),
      ]);
      let observed = false;
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            const db = connection.db!;
            const collection = db.collection.bind(db);
            const messages = db.collection('messages');
            const before = await messages.findOne({ _id: { $eq: documentId } } as never);
            expect(before).not.toBeNull();
            const after = mutation === 'delete' ? null : { ...before!, content: 'updated content' };
            const originalMutation = messages[mutation === 'replace' ? 'replaceOne' : 'deleteOne'];
            const mutationSpy = vi
              .spyOn(messages, mutation === 'replace' ? 'replaceOne' : 'deleteOne')
              .mockImplementation(async (...args: unknown[]) => {
                const filter = args[0] as mongo.Filter<mongo.Document>;
                expect(filter).toEqual({
                  _id: { $eq: documentId },
                  $expr: { $eq: ['$$ROOT', { $literal: before }] },
                });
                const explanation = await messages.find(filter).explain('executionStats');
                expect(explanation['executionStats']['nReturned']).toBe(1);
                expect(explanation['executionStats']['totalDocsExamined']).toBe(1);
                expect(explanation['executionStats']['totalKeysExamined']).toBe(1);
                // The index anchor must not weaken the complete before-image guard.
                const staleFilter = {
                  ...filter,
                  $expr: { $eq: ['$$ROOT', { $literal: { ...before, content: 'stale content' } }] },
                };
                expect(await messages.findOne(staleFilter)).toBeNull();
                observed = true;
                return Reflect.apply(originalMutation, messages, args);
              });
            const collectionSpy = vi
              .spyOn(db, 'collection')
              .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
                name === 'messages'
                  ? messages
                  : collection(name, options)) as typeof db.collection);
            try {
              await context.applyMutation('messages', before, after, 'synthetic-enrichment');
              expect(mutationSpy).toHaveBeenCalledTimes(1);
              const saved = await messages.findOne({ _id: { $eq: documentId } } as never);
              expect(saved).toEqual(after);
            } finally {
              collectionSpy.mockRestore();
              mutationSpy.mockRestore();
            }
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(observed).toBe(true);
    });
  });

  it.each(['image', 'dependency', 'counter'] as const)(
    'refuses acceptance when a fresh manifest check detects corrupted %s evidence',
    async (corruption) => {
      await withFreshConnection(async (connection) => {
        await seed(connection, [message({ timestamp: '123' })]);
        const service = new ArchiveRepairService(connection, dependencies());
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
        if (corruption === 'counter')
          await connection
            .collection(REPAIR_RUNS)
            .updateOne({ _id: plan.runId as never }, { $inc: { operations: 1 } });
        else
          await connection.collection(REPAIR_OPERATIONS).updateOne(
            { runId: plan.runId },
            {
              $set:
                corruption === 'image'
                  ? { 'after.content': 'tampered manifest' }
                  : { dependencies: ['missing-operation'] },
            },
          );
        const result = await service.execute(request('accept', plan.runId));
        expect(result.status).toBe('partial');
        expect(result.issues).toContain(
          corruption === 'counter'
            ? 'Repair manifest operation count requires recovery'
            : corruption === 'image'
              ? 'Repair manifest image or operation identity is invalid'
              : 'Repair manifest dependencies are unverified or missing',
        );
        await expect(service.execute(request('accept', plan.runId))).rejects.toThrow(
          'Only a verified complete repair can be accepted',
        );
        expect(
          (await connection.collection(REPAIR_RUNS).findOne({ _id: plan.runId as never }))?.[
            'status'
          ],
        ).toBe('partial');
      });
    },
  );

  it('marks new journals with a schema fence that an older runtime rejects', async () => {
    await withFreshConnection(async (connection) => {
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      const run = await connection.collection(REPAIR_RUNS).findOne({ _id: plan.runId as never });
      expect(run?.['journalVersion']).toBe(2);
      expect(run?.['schemaHash']).toBe('2:journal-v2');
      expect(run?.['schemaHash']).not.toBe(dependencies().schemaHash);
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
    });
  });

  it('preserves legacy journal execution and enrichment without introducing sequence reservations', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const created = await new ArchiveRepairService(connection, dependencies()).execute(
        request('plan'),
      );
      await connection
        .collection(REPAIR_RUNS)
        .updateOne(
          { _id: created.runId as never },
          { $set: { schemaHash: '2' }, $unset: { journalVersion: '', sequenceHighWatermark: '' } },
        );
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutation(
              'messages',
              null,
              message({ messageId: '112', schemaVersion: 2 }) as never,
              'synthetic-legacy',
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      expect((await service.execute(request('apply', created.runId))).status).toBe('complete');
      const operations = await connection
        .collection(REPAIR_OPERATIONS)
        .find({})
        .sort({ sequence: 1 })
        .toArray();
      expect(operations.map((operation) => operation['sequence'])).toEqual([0, 1]);
      expect(await connection.collection('messages').countDocuments({})).toBe(2);
      expect(
        await connection.collection(REPAIR_RUNS).findOne({ _id: created.runId as never }),
      ).not.toHaveProperty('sequenceHighWatermark');
    });
  });

  it('rejects unknown journal protocols before repair writes', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      await connection
        .collection(REPAIR_RUNS)
        .updateOne({ _id: plan.runId as never }, { $set: { journalVersion: 99 } });
      await expect(service.execute(request('apply', plan.runId))).rejects.toThrow(
        'Unsupported repair journal version',
      );
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
      expect((await connection.collection(REPAIR_OPERATIONS).findOne({}))?.['state']).toBe(
        'planned',
      );
    });
  });

  it('cancels an audit inside its scan and closes the cursor', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message(), message({ messageId: '112' })]);
      const controller = new AbortController();
      const classify = vi.fn(() => {
        controller.abort();
        return 'included' as const;
      });
      const service = new ArchiveRepairService(
        connection,
        dependencies({ signal: controller.signal, classify }),
      );
      expect((await service.execute(request('audit'))).status).toBe('cancelled');
      expect(classify).toHaveBeenCalledTimes(1);
      expect(await connection.collection(REPAIR_RUNS).countDocuments({})).toBe(0);
      expect(await connection.collection('messages').countDocuments({})).toBe(2);
    });
  });

  it.each(['verify', 'accept'] as const)(
    'cancels %s during fresh verification without accepting the run',
    async (command) => {
      await withFreshConnection(async (connection) => {
        await seed(connection, [message()]);
        const service = new ArchiveRepairService(connection, dependencies());
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
        const controller = new AbortController();
        const cancelling = new ArchiveRepairService(
          connection,
          dependencies({
            signal: controller.signal,
            classify: () => {
              controller.abort();
              return 'included';
            },
          }),
        );
        expect((await cancelling.execute(request(command, plan.runId))).status).toBe('cancelled');
        const run = await connection.collection(REPAIR_RUNS).findOne({ _id: plan.runId as never });
        expect(run?.['status']).toBe('complete');
        expect(run).not.toHaveProperty('acceptedAt');
        expect(run).not.toHaveProperty('expiresAt');
      });
    },
  );

  it('marks a cancelled plan as failed and leaves source data intact', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const controller = new AbortController();
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          signal: controller.signal,
          onProgress: async () => controller.abort(),
        }),
      );
      const result = await service.execute(request('plan'));
      expect(result.status).toBe('cancelled');
      const run = await connection.collection(REPAIR_RUNS).findOne({ _id: result.runId as never });
      expect(run?.['status']).toBe('failed-plan');
      expect(await connection.collection(REPAIR_OPERATIONS).countDocuments({})).toBe(0);
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
    });
  });

  it('does not begin a target mutation after shutdown during ownership validation', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const plan = await new ArchiveRepairService(connection, dependencies()).execute(
        request('plan'),
      );
      const controller = new AbortController();
      let ownerChecks = 0;
      const backfill = vi.fn().mockResolvedValue({ status: 'complete', counts: {}, issues: [] });
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          signal: controller.signal,
          backfill,
          assertOwner: async () => {
            ownerChecks += 1;
            if (ownerChecks === 2) controller.abort();
          },
        }),
      );
      expect((await service.execute(request('apply', plan.runId))).status).toBe('cancelled');
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
      expect((await connection.collection(REPAIR_OPERATIONS).findOne({}))?.['state']).toBe(
        'planned',
      );
      expect(backfill).not.toHaveBeenCalled();
      expect((await connection.collection(REPAIR_RUNS).findOne({}))?.['status']).toBe('partial');
    });
  });

  it('finishes the verification checkpoint of an already-issued target write before cancelling', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const plan = await new ArchiveRepairService(connection, dependencies()).execute(
        request('plan'),
      );
      const controller = new AbortController();
      const db = connection.db!;
      const messages = db.collection('messages');
      const replace = messages.bulkWrite.bind(messages);
      const collection = db.collection.bind(db);
      const replacement = vi.spyOn(messages, 'bulkWrite').mockImplementation(async (...args) => {
        const result = await replace(...args);
        controller.abort();
        return result;
      });
      const collectionSpy = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collection(name, options)) as typeof db.collection);
      try {
        const service = new ArchiveRepairService(
          connection,
          dependencies({ signal: controller.signal }),
        );
        const result = await service.execute(request('apply', plan.runId));
        expect(result.status).toBe('cancelled');
        expect(result.counts['applied']).toBe(1);
        expect((await messages.findOne({}))?.['timestamp']).toBe(123);
        expect((await db.collection(REPAIR_OPERATIONS).findOne({}))?.['state']).toBe('verified');
      } finally {
        collectionSpy.mockRestore();
        replacement.mockRestore();
      }
    });
  });

  it('leaves a cancelled rollback retryable and preserves the current target image', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      await service.execute(request('apply', plan.runId));
      const controller = new AbortController();
      const cancelling = new ArchiveRepairService(
        connection,
        dependencies({
          signal: controller.signal,
          onProgress: async (_phase, _committed, _total, stream) => {
            if (stream === 'rollback') controller.abort();
          },
        }),
      );
      expect((await cancelling.execute(request('rollback', plan.runId))).status).toBe('cancelled');
      expect((await connection.collection(REPAIR_RUNS).findOne({}))?.['status']).toBe(
        'rolling-back',
      );
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe(123);
      expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
    });
  });

  it('returns cancelled for a queued cancellation without touching archive data', async () => {
    await withFreshConnection(async (connection) => {
      const owner = vi.fn().mockResolvedValue(undefined);
      const service = new ArchiveRepairService(
        connection,
        dependencies({ isCancelled: async () => true, assertOwner: owner }),
      );
      expect((await service.execute(request('apply', 'synthetic-run'))).status).toBe('cancelled');
      expect(await connection.collection(REPAIR_RUNS).countDocuments({})).toBe(0);
      expect(await connection.collection('messages').countDocuments({})).toBe(0);
    });
  });

  it('submits control jobs before archive indexes exist and reads bounded manifests', async () => {
    await withFreshConnection(async (connection) => {
      const control = new ArchiveControlService(connection, '123');
      await control.submit('audit');
      expect(await connection.collection('archive_jobs').countDocuments({})).toBe(1);
      expect(
        (await connection.collection('archive_jobs').listIndexes().toArray()).map(
          (index) => index.name,
        ),
      ).toEqual(['_id_']);
      await seed(connection, [
        message({ messageId: '111', timestamp: '123' }),
        message({ messageId: '112', timestamp: '123' }),
      ]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      const manifest = await control.manifest(plan.runId!, { limit: 1 });
      expect(manifest.operations).toHaveLength(1);
      expect(manifest.operations[0]).not.toHaveProperty('before');
      expect(manifest.operations[0]).not.toHaveProperty('after');
    });
  });

  it('resumes an enrichment journal persisted before an owner interruption without duplicating its operation', async () => {
    await withFreshConnection(async (connection) => {
      const inserted = message({ schemaVersion: 2 }) as never;
      let insideEnrichment = false;
      let interrupted = false;
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          assertOwner: async () => {
            if (insideEnrichment && !interrupted) {
              interrupted = true;
              throw new Error('synthetic owner interruption');
            }
          },
          backfill: async (context) => {
            insideEnrichment = true;
            await context.applyMutation('messages', null, inserted, 'synthetic-stable-operation');
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
      expect((await service.execute(request('resume', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
      expect(await connection.collection(REPAIR_OPERATIONS).countDocuments({})).toBe(1);
    });
  });
  it('audits raw timestamp types without creating archive indexes or repair metadata', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const before = await connection.collection('messages').listIndexes().toArray();
      const service = new ArchiveRepairService(connection, dependencies());
      expect((await service.execute(request('audit'))).counts['convertible']).toBe(1);
      expect(await connection.collection('messages').listIndexes().toArray()).toEqual(before);
      expect(await connection.collection(REPAIR_RUNS).countDocuments({})).toBe(0);
    });
  });

  it('rescues timestamps, deduplicates compatible records, and reverses the journal', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' }), message({ timestamp: 123 })]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      expect(plan.status).toBe('complete');
      const result = await service.execute(request('apply', plan.runId));
      expect(result.status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe(123);
      const rollback = await service.execute(request('rollback', plan.runId));
      expect(rollback.status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({})).toBe(2);
      expect(await connection.collection('messages').countDocuments({ timestamp: '123' })).toBe(1);
    });
  });

  it('refuses stale before-images and preserves later edits during rollback', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      await connection.collection('messages').updateOne({}, { $set: { content: 'later edit' } });
      expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
      const fresh = await service.execute(request('plan'));
      expect((await service.execute(request('apply', fresh.runId))).status).toBe('complete');
      await connection
        .collection('messages')
        .updateOne({}, { $set: { content: 'another later edit' } });
      const rollback = await service.execute(request('rollback', fresh.runId));
      expect(rollback.counts['conflicts']).toBe(1);
      expect((await connection.collection('messages').findOne({}))?.['content']).toBe(
        'another later edit',
      );
    });
  });

  it.each([
    ['replace', 'object-id'],
    ['replace', 'string'],
    ['replace', 'document'],
    ['delete', 'object-id'],
    ['delete', 'string'],
    ['delete', 'document'],
  ] as const)('uses the ID index for rollback %s with a %s ID', async (mutation, idKind) => {
    await withFreshConnection(async (connection) => {
      const documentId =
        idKind === 'object-id'
          ? new mongo.ObjectId()
          : idKind === 'string'
            ? '$synthetic-id'
            : { key: 'synthetic-id' };
      const target = message({ _id: documentId, timestamp: '123' });
      await seed(connection, [
        ...Array.from({ length: 64 }, (_, index) => message({ messageId: String(1000 + index) })),
        ...(mutation === 'replace' ? [target] : []),
      ]);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            if (mutation === 'delete')
              await context.applyMutation(
                'messages',
                null,
                message({ _id: documentId, schemaVersion: 2 }) as never,
                'synthetic-insert',
              );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      const db = connection.db!;
      const collection = db.collection.bind(db);
      const messages = db.collection('messages');
      const current = await messages.findOne({ _id: { $eq: documentId } } as never);
      const lookup = await messages
        .find({ $expr: { $eq: ['$_id', { $literal: documentId }] } })
        .explain('executionStats');
      expect(lookup['executionStats']['totalDocsExamined']).toBe(1);
      const originalMutation = messages[mutation === 'replace' ? 'replaceOne' : 'deleteOne'];
      const mutationSpy = vi
        .spyOn(messages, mutation === 'replace' ? 'replaceOne' : 'deleteOne')
        .mockImplementation(async (...args: unknown[]) => {
          const filter = args[0] as mongo.Filter<mongo.Document>;
          expect(filter).toEqual({
            _id: { $eq: documentId },
            $expr: { $eq: ['$$ROOT', { $literal: current }] },
          });
          const explanation = await messages.find(filter).explain('executionStats');
          expect(explanation['executionStats']['nReturned']).toBe(1);
          expect(explanation['executionStats']['totalDocsExamined']).toBe(1);
          expect(explanation['executionStats']['totalKeysExamined']).toBe(1);
          return Reflect.apply(originalMutation, messages, args);
        });
      const collectionSpy = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string, options?: mongo.CollectionOptions) =>
          name === 'messages' ? messages : collection(name, options)) as typeof db.collection);
      try {
        expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
        expect(mutationSpy).toHaveBeenCalledTimes(1);
        const restored = await messages.findOne({ _id: { $eq: documentId } } as never);
        if (mutation === 'delete') expect(restored).toBeNull();
        else expect(restored?.['timestamp']).toBe('123');
      } finally {
        collectionSpy.mockRestore();
        mutationSpy.mockRestore();
      }
    });
  });

  it.each(['replace', 'delete'] as const)(
    'preserves a write racing with rollback %s after its current-image read',
    async (mutation) => {
      await withFreshConnection(async (connection) => {
        const target = message({ timestamp: '123' });
        if (mutation === 'replace') await seed(connection, [target]);
        const service = new ArchiveRepairService(
          connection,
          dependencies({
            backfill: async (context) => {
              if (mutation === 'delete')
                await context.applyMutation(
                  'messages',
                  null,
                  message({ _id: target['_id'], schemaVersion: 2 }) as never,
                  'synthetic-insert',
                );
              return { status: 'complete', counts: {}, issues: [] };
            },
          }),
        );
        const plan = await service.execute(request('plan'));
        expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
        const rollback = new ArchiveRepairService(
          connection,
          dependencies({
            withCapacity: async (_bytes, operation) => {
              await connection
                .collection('messages')
                .updateOne({ _id: { $eq: target['_id'] } } as never, {
                  $set: { content: 'synthetic racing edit' },
                });
              return operation();
            },
          }),
        );
        const result = await rollback.execute(request('rollback', plan.runId));
        expect(result.status).toBe('partial');
        expect(result.counts['conflicts']).toBe(1);
        expect((await connection.collection('messages').findOne({}))?.['content']).toBe(
          'synthetic racing edit',
        );
      });
    },
  );

  it('keeps successful structural work after backfill failure and resumes without duplicate writes', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const backfill = vi
        .fn()
        .mockRejectedValueOnce(new Error('synthetic interruption'))
        .mockResolvedValue({ status: 'complete', counts: {}, issues: [] });
      const service = new ArchiveRepairService(connection, dependencies({ backfill }));
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
      expect((await service.execute(request('resume', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
      expect(
        await connection.collection(REPAIR_OPERATIONS).countDocuments({ state: 'verified' }),
      ).toBe(1);
    });
  });

  it('keeps newly classified exclusions outside the approved deletion scope and reports partial', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ authorKind: undefined })]);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            const before = await connection.collection('messages').findOne({});
            await context.applyMutation(
              'messages',
              before as never,
              { ...before, authorKind: 'bot' } as never,
              'source-classification-evidence',
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      const result = await service.execute(request('apply', plan.runId));
      expect(result.status).toBe('partial');
      expect(result.issues).toContain(
        'New policy-excluded candidates require a new approved manifest',
      );
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
    });
  });

  it('preserves conflicting snapshots in quarantine until current readable source resolves the identity', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [
        message({ content: 'old evidence A' }),
        message({ content: 'old evidence B' }),
      ]);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutation(
              'messages',
              null,
              message({ content: 'current source', schemaVersion: 2 }) as never,
              'source-reconciliation',
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect(plan.status).toBe('partial');
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(await connection.collection('archive_quarantine').countDocuments({})).toBe(2);
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
      expect((await connection.collection('messages').findOne({}))?.['content']).toBe(
        'current source',
      );
    });
  });

  it('streams very large duplicate groups through bounded quarantine instead of abandoning repair', async () => {
    await withFreshConnection(async (connection) => {
      await seed(
        connection,
        Array.from({ length: 1001 }, () => message()),
      );
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      expect(plan.status).toBe('partial');
      expect(plan.counts['operations']).toBe(2002);
      expect(await connection.collection('messages').countDocuments({})).toBe(1001);
      expect(
        await connection
          .collection(REPAIR_OPERATIONS)
          .countDocuments({ reason: 'relocate-to-quarantine' }),
      ).toBe(1001);
    });
  });

  it('cleans only reliably excluded authors and journals their related reaction and revision data', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [
        message({ authorKind: 'bot' }),
        message({ messageId: '112', authorKind: undefined }),
      ]);
      await connection
        .collection('archive_revisions')
        .insertOne({ messageId: '111', snapshot: { content: 'old' } });
      await connection
        .collection('archive_reactions')
        .insertOne({ messageId: '111', userIds: ['333'] });
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({ messageId: '111' })).toBe(0);
      expect(await connection.collection('messages').countDocuments({ messageId: '112' })).toBe(1);
      expect(await connection.collection('archive_reactions').countDocuments({})).toBe(0);
      expect(
        await connection.collection(REPAIR_OPERATIONS).countDocuments({ runId: plan.runId }),
      ).toBe(3);
    });
  });

  it.each([
    { bound: 'documents', count: 501, content: 'synthetic content', sizes: [500, 1] },
    { bound: 'bytes', count: 3, content: 'x'.repeat(2100 * 1024), sizes: [1, 1, 1] },
  ])('bounds excluded-source relation discovery by $bound', async ({ count, content, sizes }) => {
    await withFreshConnection(async (connection) => {
      await seed(
        connection,
        Array.from({ length: count }, (_, index) =>
          message({ messageId: String(1000 + index), authorKind: 'bot', content }),
        ),
      );
      const db = connection.db!;
      const revisions = db.collection('archive_revisions');
      const reactions = db.collection('archive_reactions');
      const revisionFind = vi.spyOn(revisions, 'find');
      const reactionFind = vi.spyOn(reactions, 'find');
      const collection = db.collection.bind(db);
      const collectionSpy = vi
        .spyOn(db, 'collection')
        .mockImplementation(((name: string) =>
          name === 'archive_revisions'
            ? revisions
            : name === 'archive_reactions'
              ? reactions
              : collection(name)) as typeof db.collection);
      try {
        const plan = await new ArchiveRepairService(connection, dependencies()).execute(
          request('plan'),
        );
        expect(plan.status).toBe('complete');
        expect(plan.counts['operations']).toBe(count);
        expect(revisionFind).toHaveBeenCalledTimes(sizes.length);
        expect(reactionFind).toHaveBeenCalledTimes(sizes.length);
        for (const find of [revisionFind, reactionFind])
          expect(find.mock.calls.map(([filter]) => filter?.['messageId']['$in'].length)).toEqual(
            sizes,
          );
        expect(await connection.collection('messages').countDocuments({})).toBe(count);
      } finally {
        collectionSpy.mockRestore();
        revisionFind.mockRestore();
        reactionFind.mockRestore();
      }
    });
  });

  it('keeps per-message relation dependencies and restores batched excluded duplicates', async () => {
    await withFreshConnection(async (connection) => {
      const sources = [
        message({ authorKind: 'bot' }),
        message({ authorKind: 'bot' }),
        message({ messageId: '112', authorKind: 'bot' }),
        message({ messageId: '113', authorKind: null }),
      ];
      const revisions = [
        { _id: new mongo.ObjectId(), messageId: '111', snapshot: { content: 'old-a' } },
        { _id: new mongo.ObjectId(), messageId: '112', snapshot: { content: 'old-b' } },
        { _id: new mongo.ObjectId(), messageId: '111', snapshot: { content: 'older-a' } },
      ];
      const reactions = [
        { _id: new mongo.ObjectId(), messageId: '112', userIds: ['333'] },
        { _id: new mongo.ObjectId(), messageId: '111', userIds: ['444'] },
      ];
      await seed(connection, sources);
      await connection.collection('archive_revisions').insertMany(revisions);
      await connection.collection('archive_reactions').insertMany(reactions);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      expect(plan.status).toBe('complete');
      expect(plan.counts['operations']).toBe(8);
      const operations = await connection
        .collection(REPAIR_OPERATIONS)
        .find({ runId: plan.runId })
        .sort({ sequence: 1 })
        .toArray();
      const byId = new Map(operations.map((operation) => [operation._id, operation]));
      for (const operation of operations)
        for (const dependency of operation['dependencies']) {
          const previous = byId.get(dependency);
          expect(previous?.['sequence']).toBeLessThan(operation['sequence']);
          expect(previous?.['before']['messageId']).toBe(operation['before']['messageId']);
        }
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').countDocuments({})).toBe(1);
      expect(await connection.collection('archive_revisions').countDocuments({})).toBe(0);
      expect(await connection.collection('archive_reactions').countDocuments({})).toBe(0);
      expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').find({}).sort({ _id: 1 }).toArray()).toEqual(
        [...sources].sort((left, right) => String(left['_id']).localeCompare(String(right['_id']))),
      );
      expect(await connection.collection('archive_revisions').countDocuments({})).toBe(3);
      expect(await connection.collection('archive_reactions').countDocuments({})).toBe(2);
      for (const before of [...revisions, ...reactions]) {
        const collection = 'snapshot' in before ? 'archive_revisions' : 'archive_reactions';
        expect(await connection.collection(collection).findOne({ _id: before._id })).toEqual(
          before,
        );
      }
    });
  });

  it.each([
    { boundary: 'documents', preceding: 499, precedingBytes: 0, duplicateBytes: 0 },
    {
      boundary: 'bytes',
      preceding: 1,
      precedingBytes: 3 * 1024 * 1024,
      duplicateBytes: 700 * 1024,
    },
  ])(
    'deduplicates relation operations when excluded duplicates cross the $boundary batch boundary',
    async ({ preceding, precedingBytes, duplicateBytes }) => {
      await withFreshConnection(async (connection) => {
        const sources = [
          ...Array.from({ length: preceding }, (_, index) =>
            message({
              messageId: String(1000 + index),
              authorKind: 'bot',
              content: precedingBytes === 0 ? 'synthetic content' : 'x'.repeat(precedingBytes),
            }),
          ),
          ...Array.from({ length: 2 }, () =>
            message({
              messageId: '9000',
              authorKind: 'bot',
              content: duplicateBytes === 0 ? 'synthetic content' : 'x'.repeat(duplicateBytes),
            }),
          ),
        ];
        const revision = {
          _id: new mongo.ObjectId(),
          messageId: '9000',
          snapshot: { content: 'old' },
        };
        const reaction = { _id: new mongo.ObjectId(), messageId: '9000', userIds: ['333'] };
        await seed(connection, sources);
        await connection.collection('archive_revisions').insertOne(revision);
        await connection.collection('archive_reactions').insertOne(reaction);
        const service = new ArchiveRepairService(connection, dependencies());
        const plan = await service.execute(request('plan'));
        expect(plan.status).toBe('complete');
        expect(plan.counts['operations']).toBe(sources.length + 2);
        const operations = await connection
          .collection(REPAIR_OPERATIONS)
          .find({ runId: plan.runId })
          .sort({ sequence: 1 })
          .toArray();
        const related = operations.filter(
          (operation) => operation['reason'] === 'policy-excluded-related-record',
        );
        expect(related).toHaveLength(2);
        const duplicateSources = operations.filter(
          (operation) =>
            operation['collection'] === 'messages' && operation['before']['messageId'] === '9000',
        );
        expect(duplicateSources).toHaveLength(2);
        for (const operation of duplicateSources) {
          expect(operation['dependencies']).toEqual([related[1]!._id]);
          expect(operation['sequence']).toBeGreaterThan(related[1]!['sequence']);
        }
        expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
        expect(await connection.collection('messages').countDocuments({})).toBe(0);
        expect(await connection.collection('archive_revisions').countDocuments({})).toBe(0);
        expect(await connection.collection('archive_reactions').countDocuments({})).toBe(0);
        expect((await service.execute(request('rollback', plan.runId))).status).toBe('complete');
        expect(await connection.collection('messages').find({}).sort({ _id: 1 }).toArray()).toEqual(
          [...sources].sort((left, right) =>
            String(left['_id']).localeCompare(String(right['_id'])),
          ),
        );
        expect(await connection.collection('archive_revisions').findOne({})).toEqual(revision);
        expect(await connection.collection('archive_reactions').findOne({})).toEqual(reaction);
      });
    },
  );

  it('drops pending excluded-source batches when planning is cancelled without mutating sources', async () => {
    await withFreshConnection(async (connection) => {
      await seed(
        connection,
        ['111', '112', '113'].map((messageId) => message({ messageId, authorKind: 'bot' })),
      );
      const controller = new AbortController();
      let classified = 0;
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          signal: controller.signal,
          classify: () => {
            if (++classified === 3) controller.abort();
            return 'excluded';
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect(plan.status).toBe('cancelled');
      expect(await connection.collection(REPAIR_OPERATIONS).countDocuments({})).toBe(0);
      expect(await connection.collection('messages').countDocuments({})).toBe(3);
      expect((await connection.collection(REPAIR_RUNS).findOne({}))?.['status']).toBe(
        'failed-plan',
      );
    });
  });

  it('journals malformed and duplicate cursor reset before full reconciliation and restores cursors on rollback', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message()]);
      await connection.collection('fetches').insertMany([
        { channelID: '222', channel: 'synthetic', lastMessageID: 'malformed-cursor' },
        { channelID: '222', channel: 'synthetic', lastMessageID: '111' },
      ]);
      const service = new ArchiveRepairService(connection, dependencies());
      expect((await service.execute(request('audit'))).counts['invalidCursors']).toBe(1);
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(await connection.collection('fetches').countDocuments({})).toBe(1);
      expect((await connection.collection('fetches').findOne({}))?.['lastMessageID']).toBe('');
      await service.execute(request('rollback', plan.runId));
      expect(await connection.collection('fetches').countDocuments({})).toBe(2);
      expect(
        await connection
          .collection('fetches')
          .countDocuments({ lastMessageID: 'malformed-cursor' }),
      ).toBe(1);
    });
  });

  it('preserves deletion-only tombstones without manufacturing missing timestamps', async () => {
    await withFreshConnection(async (connection) => {
      const tombstone = {
        _id: new mongo.ObjectId(),
        messageId: '111',
        channelId: '222',
        schemaVersion: 2,
        authorKind: 'unknown',
        deletion: { deletedAt: 123 },
      };
      await seed(connection, [tombstone]);
      const service = new ArchiveRepairService(connection, dependencies());
      const plan = await service.execute(request('plan'));
      expect(plan.counts['operations']).toBe(0);
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      expect(await connection.collection('messages').findOne({})).toEqual(tombstone);
    });
  });

  it('preserves linked reaction generations and revisions when a later message edit conflicts with rollback', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutation(
              'archive_reactions',
              null,
              {
                _id: new mongo.ObjectId(),
                messageId: '111',
                generation: 'repair-generation',
                chunk: 0,
                userIds: ['333'],
              },
              'reaction-stage',
            );
            await context.applyMutation(
              'archive_revisions',
              null,
              {
                _id: new mongo.ObjectId(),
                messageId: '111',
                contentVersionAt: 123,
                snapshot: { content: 'observed version' },
              },
              'message-revision',
            );
            const before = await connection.collection('messages').findOne({});
            await context.applyMutation(
              'messages',
              before as never,
              {
                ...before,
                reactionGenerations: { normal: { generation: 'repair-generation' } },
              } as never,
              'reaction-publish',
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      await service.execute(request('apply', plan.runId));
      await connection
        .collection('messages')
        .updateOne({}, { $set: { content: 'later live edit' } });
      const result = await service.execute(request('rollback', plan.runId));
      expect(result.status).toBe('partial');
      expect(result.counts['restored']).toBe(0);
      expect(
        await connection
          .collection('archive_reactions')
          .countDocuments({ generation: 'repair-generation' }),
      ).toBe(1);
      expect(await connection.collection('archive_revisions').countDocuments({})).toBe(1);
      expect((await connection.collection('messages').findOne({}))?.['content']).toBe(
        'later live edit',
      );
    });
  });

  it('retains observed edit versions indefinitely even after an otherwise successful rollback', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await context.applyMutation(
              'archive_revisions',
              null,
              {
                _id: new mongo.ObjectId(),
                messageId: '111',
                contentVersionAt: 123,
                snapshot: { content: 'observed version' },
              },
              'message-revision',
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      await service.execute(request('apply', plan.runId));
      const result = await service.execute(request('rollback', plan.runId));
      expect(result.status).toBe('complete');
      expect(result.counts['retainedRevisions']).toBe(1);
      expect(await connection.collection('archive_revisions').countDocuments({})).toBe(1);
      expect((await connection.collection('messages').findOne({}))?.['timestamp']).toBe('123');
    });
  });

  it('blocks missing index builds at conservative peak capacity and avoids that reservation for correct existing indexes', async () => {
    await withFreshConnection(async (connection) => {
      await seed(connection, [message({ timestamp: '123' })]);
      const backfill = vi.fn().mockResolvedValue({ status: 'complete', counts: {}, issues: [] });
      const ensureCapacity = vi.fn(async (bytes: number) => {
        if (bytes > 1024 * 1024) throw new Error('synthetic index capacity limit');
      });
      const service = new ArchiveRepairService(
        connection,
        dependencies({ backfill, ensureCapacity }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('partial');
      expect(backfill).not.toHaveBeenCalled();
      const messages = connection.collection('messages');
      await messages.createIndex({ messageId: 1 }, { unique: true, name: 'messageId_1' });
      await messages.createIndex({ timestamp: 1 }, { name: 'timestamp_1' });
      await messages.createIndex(
        { channelId: 1, timestamp: 1 },
        { name: 'channelId_1_timestamp_1' },
      );
      ensureCapacity.mockClear();
      expect((await service.execute(request('resume', plan.runId))).status).toBe('complete');
      expect(ensureCapacity.mock.calls.every(([bytes]) => bytes < 1024 * 1024)).toBe(true);
    });
  });

  it('starts the 72-hour retention clock only after complete repair acceptance', async () => {
    await withFreshConnection(async (connection) => {
      let now = 1000;
      await seed(connection, [message({ timestamp: '123' })]);
      const service = new ArchiveRepairService(connection, dependencies({ now: () => now }));
      const plan = await service.execute(request('plan'));
      await service.execute(request('apply', plan.runId));
      now += 10 * 86400000;
      expect(await service.cleanupAccepted()).toBe(0);
      const accepted = await service.execute(request('accept', plan.runId));
      expect(accepted.details?.['expiresAt']).toBe(now + 72 * 3600000);
      now += 72 * 3600000 - 1;
      expect(await service.cleanupAccepted()).toBe(0);
      now += 1;
      expect(await service.cleanupAccepted()).toBe(1);
      expect(await connection.collection(REPAIR_OPERATIONS).countDocuments({})).toBe(0);
    });
  });

  it('journals concurrent enrichment mutations with unique contiguous operation identities', async () => {
    await withFreshConnection(async (connection) => {
      const service = new ArchiveRepairService(
        connection,
        dependencies({
          backfill: async (context) => {
            await Promise.all(
              ['111', '112'].map((messageId) =>
                context.applyMutation(
                  'messages',
                  null,
                  message({ messageId, schemaVersion: 2 }) as never,
                  'synthetic-enrichment',
                ),
              ),
            );
            return { status: 'complete', counts: {}, issues: [] };
          },
        }),
      );
      const plan = await service.execute(request('plan'));
      expect((await service.execute(request('apply', plan.runId))).status).toBe('complete');
      const operations = await connection
        .collection(REPAIR_OPERATIONS)
        .find({})
        .sort({ sequence: 1 })
        .toArray();
      expect(operations.map((operation) => operation['sequence'])).toEqual([0, 1]);
    });
  });
});
