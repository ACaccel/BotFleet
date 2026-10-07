import { afterEach, describe, expect, it, vi } from 'vitest';
import { mongo } from 'mongoose';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { withFreshConnection } from '../helpers/mongo';

const actor = { userId: '456', channelId: '789' };
const manifest = (patch: Record<string, unknown> = {}) => ({
  _id: 'synthetic-run',
  guildId: '123',
  status: 'planned',
  schemaHash: 'archive-v2',
  policyHash: 'synthetic-policy',
  createdAt: 1,
  validUntil: Date.now() + 60_000,
  operations: 0,
  unresolved: 0,
  journalBytes: 100,
  issues: [],
  ...patch,
});
afterEach(() => vi.restoreAllMocks());

describe('archive Discord control persistence', () => {
  it('summarizes the complete manifest with explicit deletion impacts and operation units', async () =>
    withFreshConnection(async (connection) => {
      const changes = [
        ['fetches', 'reset-cursor-for-full-reconciliation', 'update'],
        ['fetches', 'delete-duplicate-cursor', 'delete'],
        ['messages', 'merge-compatible-duplicate', 'update'],
        ['messages', 'delete-verified-duplicate', 'delete'],
        ['messages', 'policy-excluded-source', 'delete'],
        ['archive_revisions', 'policy-excluded-related-record', 'delete'],
        ['archive_quarantine', 'preserve-quarantine-evidence', 'insert'],
        ['messages', 'relocate-to-quarantine', 'delete'],
        ['fetches', 'quarantine-invalid-cursor', 'delete'],
        ['messages', 'future-private-code', 'update'],
        ['unexpected-collection', 'rescue-timestamp', 'update'],
      ];
      const operations = [
        ...Array.from({ length: 125 }, () => ['messages', 'rescue-timestamp', 'update']),
        ...changes,
      ].map(([collection, reason, mutation], sequence) => ({
        _id: `op-${sequence}`,
        runId: 'synthetic-run',
        sequence,
        collection,
        reason,
        state: 'planned',
        documentId: '111',
        before: mutation === 'insert' ? null : { content: 'private recovery data' },
        after: mutation === 'delete' ? null : { content: 'private updated recovery data' },
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        dependencies: [],
      }));
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: operations.length }) as never);
      await connection.collection('archive_repair_operations').insertMany(operations as never);
      const aggregate = vi.spyOn(connection.collection('archive_repair_operations'), 'aggregate');
      const service = new ArchiveControlService(connection, '123');
      const page = await service.manifest('synthetic-run', { limit: 1 });
      expect(page.operations).toHaveLength(1);
      expect(page.summary).toMatchObject({
        status: 'available',
        totalOperations: 136,
        impacts: {
          insertOperations: 1,
          updateOperations: 129,
          deleteOperations: 6,
          unknownImpactOperations: 0,
        },
      });
      if (page.summary.status !== 'available') throw new Error('Expected available summary');
      expect(page.summary.categories.map((entry) => [entry.category, entry.operations])).toEqual([
        ['reset-progress', 1],
        ['remove-duplicate-progress', 1],
        ['repair-message-time', 125],
        ['merge-duplicate-messages', 2],
        ['exclude-by-policy', 2],
        ['quarantine-data', 3],
        ['unknown', 2],
      ]);
      expect(page.summary).not.toHaveProperty('messages');
      expect(page.summary).not.toHaveProperty('sources');
      expect(JSON.stringify(page)).not.toContain('recovery data');
      expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
        maxTimeMS: 5000,
        allowDiskUse: false,
      });
      const unknown = await service.manifest('synthetic-run', { category: 'unknown' });
      expect(unknown.operations.map((operation) => operation.reason)).toEqual([
        'future-private-code',
        'rescue-timestamp',
      ]);
      expect(unknown.operations.every((operation) => operation.category === 'unknown')).toBe(true);
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      expect(confirmation.summary).toEqual(page.summary);
      await expect(
        new ArchiveControlService(connection, '999').manifestSummary('synthetic-run'),
      ).rejects.toThrow('Unknown');
    }));

  it('navigates sparse category pages in both directions without changing whole-manifest totals', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: 7 }) as never);
      await connection.collection('archive_repair_operations').insertMany(
        Array.from({ length: 7 }, (_, sequence) => ({
          _id: `op-${sequence}`,
          runId: 'synthetic-run',
          sequence,
          collection: sequence % 2 === 0 ? 'fetches' : 'messages',
          reason: sequence % 2 === 0 ? 'delete-duplicate-cursor' : 'rescue-timestamp',
          before: { content: 'private' },
          after: sequence % 2 === 0 ? null : { content: 'private' },
        })) as never,
      );
      const service = new ArchiveControlService(connection, '123');
      const first = await service.manifest('synthetic-run', {
        category: 'remove-duplicate-progress',
        limit: 2,
      });
      expect(first.operations.map((operation) => operation.sequence)).toEqual([0, 2]);
      expect(first).toMatchObject({ hasPrevious: false, hasNext: true, nextCursor: 2 });
      const second = await service.manifest('synthetic-run', {
        category: 'remove-duplicate-progress',
        afterSequence: first.nextCursor,
        limit: 2,
      });
      expect(second.operations.map((operation) => operation.sequence)).toEqual([4, 6]);
      expect(second).toMatchObject({ hasPrevious: true, hasNext: false, previousCursor: 4 });
      const previous = await service.manifest('synthetic-run', {
        category: 'remove-duplicate-progress',
        beforeSequence: second.previousCursor,
        limit: 2,
      });
      expect(previous.operations).toEqual(first.operations);
      expect(previous.summary).toEqual(second.summary);
      const empty = await service.manifest('synthetic-run', { category: 'quarantine-data' });
      expect(empty).toMatchObject({ operations: [], hasPrevious: false, hasNext: false });
      await expect(
        service.manifest('synthetic-run', { afterSequence: 0, beforeSequence: 3 }),
      ).rejects.toThrow('one direction');
    }));

  it('keeps zero-operation legacy manifests and unknown impacts visible without exposing images', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      expect(await service.manifestSummary('synthetic-run')).toEqual({
        status: 'available',
        totalOperations: 0,
        targets: { distinctSources: 0, unknownSourceOperations: 0 },
        recordTypes: [],
        categories: [],
        impacts: {
          insertOperations: 0,
          updateOperations: 0,
          deleteOperations: 0,
          unknownImpactOperations: 0,
        },
      });
      expect((await service.manifest('synthetic-run')).run.journalVersion).toBe(1);
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'synthetic-run' } as never, { $set: { operations: 1 } });
      await connection.collection('archive_repair_operations').insertOne({
        _id: 'unknown-operation',
        runId: 'synthetic-run',
        sequence: 0,
        collection: 'messages',
        reason: { content: 'private malformed reason' },
        before: null,
        after: null,
      } as never);
      expect(await service.manifestSummary('synthetic-run')).toMatchObject({
        status: 'available',
        totalOperations: 1,
        categories: [{ category: 'unknown', operations: 1, unknownImpactOperations: 1 }],
      });
      const page = await service.manifest('synthetic-run');
      expect(page.operations[0]).toMatchObject({ reason: 'other', category: 'unknown' });
      expect(JSON.stringify(page)).not.toContain('private malformed');
    }));

  it('reports unavailable totals on timeout and fails closed before approvals or jobs are written', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      vi.spyOn(connection.collection('archive_repair_operations'), 'aggregate').mockImplementation(
        () => {
          throw new mongo.MongoServerError({ code: 50, message: 'private database details' });
        },
      );
      const page = await service.manifest('synthetic-run');
      expect(page.summary).toEqual({ status: 'unavailable', reason: 'timeout' });
      expect(page.run.actions).toEqual([]);
      expect(page.summary).not.toHaveProperty('totalOperations');
      expect(JSON.stringify(page)).not.toContain('private database');
      await expect(service.requestConfirmation('apply', 'synthetic-run', actor)).rejects.toThrow(
        'summary unavailable',
      );
      await expect(service.confirm(confirmation.token, actor)).rejects.toThrow(
        'summary unavailable',
      );
      expect(await connection.collection('archive_control_confirmations').countDocuments()).toBe(1);
      expect(
        await connection
          .collection('archive_control_confirmations')
          .findOne({ _id: confirmation.token } as never),
      ).not.toHaveProperty('consumedAt');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('projects operation effects safely and marks missing or malformed recovery images as unknown', async () =>
    withFreshConnection(async (connection) => {
      const image = { content: 'private message body', url: 'https://signed.invalid?token=secret' };
      const cases = [
        { before: null, after: image },
        { before: image, after: image },
        { before: image, after: null },
        { before: null, after: null },
        { after: image },
        { before: image },
        { before: [], after: image },
      ];
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: cases.length }) as never);
      await connection.collection('archive_repair_operations').insertMany(
        cases.map((images, sequence) => ({
          _id: `effect-${sequence}`,
          runId: 'synthetic-run',
          sequence,
          collection: 'messages',
          reason: 'future-repair-code',
          ...images,
        })) as never,
      );
      const page = await new ArchiveControlService(connection, '123').manifest('synthetic-run');
      expect(page.operations.map((operation) => operation.impact)).toEqual([
        'insert',
        'update',
        'delete',
        'unknown',
        'unknown',
        'unknown',
        'unknown',
      ]);
      expect(page.summary).toMatchObject({
        status: 'available',
        impacts: {
          insertOperations: 1,
          updateOperations: 1,
          deleteOperations: 1,
          unknownImpactOperations: 4,
        },
      });
      expect(JSON.stringify(page)).not.toMatch(/private message|signed\.invalid|token=secret/);
      expect(
        page.operations.every((operation) => !('before' in operation) && !('after' in operation)),
      ).toBe(true);
    }));

  it('rejects mismatched counts and hides acceptance after incomplete jobs or active work', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: 2 }) as never);
      const service = new ArchiveControlService(connection, '123');
      expect(await service.manifestSummary('synthetic-run')).toEqual({
        status: 'unavailable',
        reason: 'invalid-data',
      });
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'synthetic-run' } as never, {
          $set: { operations: 0, status: 'complete' },
        });
      expect((await service.manifest('synthetic-run')).run.actions).toContain('accept');
      await connection.collection('archive_jobs').insertOne({
        _id: '123:old-apply',
        jobId: '123:old-apply',
        requestId: 'old-apply',
        guildId: '123',
        command: 'apply',
        runId: 'synthetic-run',
        status: 'partial',
        createdAt: 1,
      } as never);
      expect((await service.manifest('synthetic-run')).run.actions).not.toContain('accept');
      await expect(service.requestConfirmation('accept', 'synthetic-run', actor)).rejects.toThrow(
        'eligible',
      );
      await connection
        .collection('archive_jobs')
        .updateOne({ _id: '123:old-apply' } as never, { $set: { status: 'running' } });
      expect((await service.manifest('synthetic-run')).run.actions).toEqual([]);
      await connection
        .collection('archive_jobs')
        .updateOne({ _id: '123:old-apply' } as never, { $set: { status: 'complete' } });
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'synthetic-run' } as never, {
          $set: { coverage: { status: 'partial' } },
        });
      expect((await service.manifest('synthetic-run')).run.actions).not.toContain('accept');
    }));

  it('uses successful verification instead of historical plan issues and survives purged jobs', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(
        manifest({
          status: 'complete',
          unresolved: 3,
          issues: ['Quarantined initial candidates with private details'],
          verifiedAt: 10,
          coverage: { status: 'complete' },
        }) as never,
      );
      await connection.collection('archive_jobs').insertOne({
        _id: '123:resolved-apply',
        jobId: '123:resolved-apply',
        requestId: 'resolved-apply',
        guildId: '123',
        command: 'apply',
        runId: 'synthetic-run',
        status: 'complete',
        createdAt: 1,
        finishedAt: 11,
        result: { status: 'complete', counts: { unresolvedEvidence: 0 }, issues: [] },
      } as never);
      const service = new ArchiveControlService(connection, '123');
      const current = await service.manifest('synthetic-run');
      expect(current.run.actions).toContain('accept');
      expect(current.run).toMatchObject({
        unresolved: 3,
        issueCount: 1,
        verification: { status: 'complete', unresolved: 0, issueCount: 0, checkedAt: 11 },
      });
      expect(await service.purgeJobs()).toEqual({ deleted: 1, running: 0 });
      const restarted = new ArchiveControlService(connection, '123');
      const retained = await restarted.manifest('synthetic-run');
      expect(retained.run.actions).toContain('accept');
      expect(retained.run.verification).toMatchObject({
        status: 'complete',
        unresolved: 0,
        issueCount: 0,
        checkedAt: 10,
      });
      expect((await restarted.requestConfirmation('accept', 'synthetic-run', actor)).action).toBe(
        'accept',
      );
    }));

  it('refuses to bind a confirmation when the manifest changes during summary collection', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const operations = connection.collection('archive_repair_operations');
      const aggregate = operations.aggregate.bind(operations);
      vi.spyOn(operations, 'aggregate').mockImplementationOnce((...args) => {
        const cursor = aggregate(...args);
        const read = cursor.toArray.bind(cursor);
        vi.spyOn(cursor, 'toArray').mockImplementationOnce(async () => {
          const summary = await read();
          await operations.insertOne({
            _id: 'new-operation',
            runId: 'synthetic-run',
            sequence: 0,
            collection: 'messages',
            reason: 'policy-excluded-source',
            before: { content: 'private' },
            after: null,
          } as never);
          await connection
            .collection('archive_repair_runs')
            .updateOne({ _id: 'synthetic-run' } as never, { $set: { operations: 1 } });
          return summary;
        });
        return cursor;
      });
      await expect(service.requestConfirmation('apply', 'synthetic-run', actor)).rejects.toThrow(
        'manifest changed',
      );
      expect(await connection.collection('archive_control_confirmations').countDocuments()).toBe(0);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('binds approval to the displayed impact even when corrupt images retain their stored hashes', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: 1 }) as never);
      await connection.collection('archive_repair_operations').insertOne({
        _id: 'time-repair',
        runId: 'synthetic-run',
        sequence: 0,
        collection: 'messages',
        reason: 'rescue-timestamp',
        before: { content: 'private', timestamp: '123' },
        after: { content: 'private', timestamp: 123 },
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
      } as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      expect(confirmation.summary).toMatchObject({
        status: 'available',
        impacts: { updateOperations: 1, deleteOperations: 0 },
      });
      await connection
        .collection('archive_repair_operations')
        .updateOne({ _id: 'time-repair' } as never, { $set: { after: null } });
      await expect(service.confirm(confirmation.token, actor)).rejects.toThrow('manifest changed');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
      expect(
        await connection
          .collection('archive_control_confirmations')
          .findOne({ _id: confirmation.token } as never),
      ).not.toHaveProperty('consumedAt');
    }));

  it('dispatches versioned manifest schema fences through autocomplete, confirmation and enqueue', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertMany([
          manifest({ _id: 'legacy', journalVersion: 1 }),
          manifest({ _id: 'new-v2', journalVersion: 2, schemaHash: 'archive-v2:journal-v2' }),
          manifest({ _id: 'future', journalVersion: 3, schemaHash: 'archive-v2:journal-v3' }),
          manifest({ _id: 'mismatched', journalVersion: 2 }),
        ] as never);
      const control = new ArchiveControlService(connection, '123');
      const choices = await control.autocomplete('run', '', 'apply');
      expect(choices.map((choice) => choice.value).sort()).toEqual(['legacy', 'new-v2']);
      for (const runId of ['legacy', 'new-v2']) {
        const confirmation = await control.requestConfirmation('apply', runId, actor);
        const job = await control.confirm(confirmation.token, actor);
        expect(job).toMatchObject({ command: 'apply', runId, status: 'queued' });
      }
      for (const runId of ['future', 'mismatched'])
        await expect(control.requestConfirmation('apply', runId, actor)).rejects.toThrow(
          'settings changed',
        );
      const inspected = await control.manifest('new-v2');
      expect(inspected.run).toMatchObject({
        schemaHash: 'archive-v2:journal-v2',
        journalVersion: 2,
      });
    }));

  it('paginates every flattened source gap without mixing guilds or exceeding summary bounds', async () =>
    withFreshConnection(async (connection) => {
      const rows = connection.collection('archive_progress_details');
      const reasons = ['permission', 'discovery', 'capacity', 'conflict', 'other'] as const;
      await rows.insertMany([
        {
          guildId: '123',
          scopeId: 'job',
          sourceId: '10',
          activity: {
            sourceId: '10',
            name: 'source',
            step: 'checkpoint',
            scanned: 3,
            cursor: '100',
            startedAt: 0,
            updatedAt: 1,
          },
        },
        ...reasons.map((reason) => ({
          guildId: '123',
          scopeId: 'job',
          sourceId: `10:gap:${reason}`,
          gaps: [{ sourceId: '10', name: 'source', reason }],
        })),
        {
          guildId: '999',
          scopeId: 'job',
          sourceId: '00',
          gaps: [{ sourceId: '00', name: 'foreign', reason: 'permission' }],
        },
      ]);
      const control = new ArchiveControlService(connection, '123');
      const first = await control.progressDetails('job', 1);
      const second = await control.progressDetails('job', 2);
      expect(first.hasNext).toBe(true);
      expect(second.hasNext).toBe(false);
      expect(first.activities).toHaveLength(1);
      expect([...first.gaps, ...second.gaps].map((gap) => gap.reason).sort()).toEqual(
        [...reasons].sort(),
      );
      expect(first.gaps.length).toBeLessThanOrEqual(3);
      expect(second.gaps.length).toBeLessThanOrEqual(3);
      expect(JSON.stringify([first, second])).not.toContain('foreign');
    }));

  it('binds confirmation to user, guild and channel and atomically submits concurrent replays', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      expect(confirmation.token).toHaveLength(24);
      await service.validateConfirmation(confirmation.token, actor);
      await expect(
        service.validateConfirmation(confirmation.token, { ...actor, userId: '999' }),
      ).rejects.toThrow('actor');
      expect(
        (
          await connection
            .collection('archive_control_confirmations')
            .findOne({ _id: confirmation.token } as never)
        )?.['consumedAt'],
      ).toBeUndefined();
      await expect(
        service.confirm(confirmation.token, { ...actor, userId: '999' }),
      ).rejects.toThrow('actor');
      await expect(
        service.confirm(confirmation.token, { ...actor, channelId: '999' }),
      ).rejects.toThrow('actor');
      await expect(
        new ArchiveControlService(connection, '999').confirm(confirmation.token, actor),
      ).rejects.toThrow('actor');
      const jobs = await Promise.all(
        Array.from({ length: 15 }, () =>
          service.confirm(confirmation.token, actor, { channelId: '789', messageId: '111' }),
        ),
      );
      expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
      expect(await connection.collection('archive_jobs').findOne({})).toMatchObject({
        command: 'apply',
        runId: 'synthetic-run',
        notification: { channelId: '789', messageId: '111' },
      });
      const restarted = new ArchiveControlService(connection, '123');
      vi.spyOn(Date, 'now').mockReturnValue(confirmation.expiresAt + 1000);
      expect((await restarted.confirm(confirmation.token, actor)).jobId).toBe(jobs[0]!.jobId);
    }));

  it('recovers an approved request interrupted before job insertion with its stable request token', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      // A process can stop between consuming the approval and submitting the stable request.
      await connection
        .collection('archive_control_confirmations')
        .updateOne({ _id: confirmation.token } as never, { $set: { consumedAt: Date.now() } });
      const resumed = await new ArchiveControlService(connection, '123').confirm(
        confirmation.token,
        actor,
      );
      expect(resumed.status).toBe('queued');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(1);
    }));

  it('rejects expiry and changed manifest hashes, revision and settings without creating jobs', async () =>
    withFreshConnection(async (connection) => {
      let currentPolicy = 'synthetic-policy';
      await connection
        .collection('archive_repair_runs')
        .insertOne(manifest({ operations: 1 }) as never);
      await connection.collection('archive_repair_operations').insertOne({
        _id: 'operation-1',
        runId: 'synthetic-run',
        sequence: 0,
        before: { content: 'private before' },
        after: { content: 'private after' },
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
      } as never);
      const service = new ArchiveControlService(connection, '123', {
        policyHash: () => currentPolicy,
      });
      const first = await service.requestConfirmation('apply', 'synthetic-run', actor);
      await connection
        .collection('archive_repair_operations')
        .updateOne({ _id: 'operation-1' } as never, {
          $set: { beforeHash: 'c'.repeat(64) },
        });
      await expect(service.confirm(first.token, actor)).rejects.toThrow('manifest changed');
      const second = await service.requestConfirmation('apply', 'synthetic-run', actor);
      await connection
        .collection('archive_repair_runs')
        .updateOne({ _id: 'synthetic-run' } as never, { $set: { revision: 2 } });
      await expect(service.confirm(second.token, actor)).rejects.toThrow('manifest changed');
      const third = await service.requestConfirmation('apply', 'synthetic-run', actor);
      currentPolicy = 'changed-policy';
      await expect(service.confirm(third.token, actor)).rejects.toThrow('settings changed');
      currentPolicy = 'synthetic-policy';
      vi.spyOn(Date, 'now').mockReturnValue(third.expiresAt + 1);
      await expect(service.confirm(third.token, actor)).rejects.toThrow('expired');
      await expect(service.validateConfirmation(third.token, actor)).rejects.toThrow('expired');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));

  it('projects safe bounded manifest/status data and isolates guild reads and cancellation', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(
        manifest({
          operations: 3,
          secret: 'private manifest content',
          issues: ['Permission denied with private content'],
        }) as never,
      );
      await connection.collection('archive_repair_operations').insertMany(
        Array.from({ length: 3 }, (_, sequence) => ({
          _id: `op-${sequence}`,
          runId: 'synthetic-run',
          sequence,
          collection: 'messages',
          state: 'planned',
          reason: 'invalid-timestamp',
          dependencies: [],
          before: { content: 'private before', url: 'https://signed.invalid' },
          after: { content: 'private after' },
          documentId: { content: 'private document' },
        })) as never,
      );
      const service = new ArchiveControlService(connection, '123');
      const first = await service.manifest('synthetic-run', { limit: 1 });
      expect(first.operations).toHaveLength(1);
      expect(first.nextSequence).toBe(0);
      expect(
        (await service.manifest('synthetic-run', { afterSequence: first.nextSequence, limit: 1 }))
          .operations[0]?.sequence,
      ).toBe(1);
      expect(JSON.stringify(first)).not.toMatch(/private|signed\.invalid|documentId/);
      expect(first.run.issueCategories).toEqual(['permission']);
      const job = await service.submit('audit');
      await connection.collection('archive_jobs').updateOne(
        { jobId: job.jobId },
        {
          $set: {
            result: {
              counts: { total: 4, private: 99 },
              issues: ['coverage missing secret body'],
              before: 'private content',
              attachment: 'https://signed.invalid',
              error: { message: 'private error' },
            },
          },
        },
      );
      const summary = await service.status(job.jobId);
      expect(summary.counts).toEqual({ total: 4 });
      expect(summary.issueCount).toBe(2);
      expect(JSON.stringify(summary)).not.toMatch(/private|secret body|signed\.invalid/);
      const other = new ArchiveControlService(connection, '999');
      await expect(other.status(job.jobId)).rejects.toThrow('Unknown');
      await expect(other.cancel(job.jobId)).rejects.toThrow('Unknown');
      await expect(other.manifest('synthetic-run')).rejects.toThrow('Unknown');
      expect((await service.status(job.jobId)).cancelRequested).toBe(false);
      expect((await service.cancel(job.jobId)).cancelRequested).toBe(true);
    }));

  it('finishes queued cancellation immediately without an archive worker', async () =>
    withFreshConnection(async (connection) => {
      const service = new ArchiveControlService(connection, '123');
      const job = await service.submit('audit');
      vi.spyOn(Date, 'now').mockReturnValue(2000);
      const cancelled = await service.cancel(job.jobId);
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: 2000,
      });
      expect(cancelled.startedAt).toBeUndefined();
      expect((await service.jobs()).jobs).toHaveLength(0);
      expect(await service.autocomplete('job', '', 'cancel')).toHaveLength(0);
      expect(
        await connection
          .collection('archive_jobs')
          .findOneAndUpdate(
            { jobId: job.jobId, status: 'queued', cancelRequested: false },
            { $set: { status: 'running', startedAt: 3000 } },
            { returnDocument: 'after' },
          ),
      ).toBeNull();
      vi.mocked(Date.now).mockReturnValue(4000);
      expect((await service.cancel(job.jobId)).finishedAt).toBe(2000);
    }));

  it('requests running cancellation cooperatively and preserves terminal jobs', async () =>
    withFreshConnection(async (connection) => {
      const service = new ArchiveControlService(connection, '123');
      const running = await service.submit('audit');
      await connection
        .collection('archive_jobs')
        .updateOne(
          { jobId: running.jobId },
          { $set: { status: 'running', startedAt: 1000, claimToken: 'worker-claim' } },
        );
      const cancelled = await service.cancel(running.jobId);
      expect(cancelled).toMatchObject({
        status: 'running',
        startedAt: 1000,
        cancelRequested: true,
      });
      expect(cancelled.finishedAt).toBeUndefined();
      expect(
        await connection.collection('archive_jobs').findOne({ jobId: running.jobId }),
      ).toMatchObject({ claimToken: 'worker-claim' });
      for (const status of ['complete', 'partial', 'failed', 'cancelled']) {
        const terminal = await service.submit('audit');
        await connection
          .collection('archive_jobs')
          .updateOne(
            { jobId: terminal.jobId },
            { $set: { status, finishedAt: 1500, result: { counts: { total: 7 } } } },
          );
        expect(await service.cancel(terminal.jobId)).toMatchObject({
          status,
          finishedAt: 1500,
          cancelRequested: false,
          counts: { total: 7 },
        });
      }
    }));

  it('purges only this guild queued and terminal jobs while preserving archive data and running jobs', async () =>
    withFreshConnection(async (connection) => {
      const service = new ArchiveControlService(connection, '123');
      for (const status of ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled']) {
        const job = await service.submit('audit');
        await connection
          .collection('archive_jobs')
          .updateOne({ jobId: job.jobId }, { $set: { status } });
      }
      const foreign = await new ArchiveControlService(connection, '999').submit('audit');
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      await connection
        .collection('archive_journals')
        .insertOne({ _id: 'retained-journal' } as never);
      expect(await service.purgeJobs()).toEqual({ deleted: 5, running: 1 });
      expect((await service.jobs({ all: true })).jobs).toHaveLength(1);
      expect((await service.jobs({ all: true })).jobs[0]?.status).toBe('running');
      expect(
        await connection.collection('archive_jobs').findOne({ jobId: foreign.jobId }),
      ).not.toBeNull();
      expect(await connection.collection('archive_repair_runs').countDocuments()).toBe(1);
      expect(await connection.collection('archive_journals').countDocuments()).toBe(1);
      expect(await service.purgeJobs()).toEqual({ deleted: 0, running: 1 });
    }));

  it('keeps approval receipts so replay cannot recreate a purged job', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      await service.confirm(confirmation.token, actor);
      expect(await service.purgeJobs()).toEqual({ deleted: 1, running: 0 });
      await expect(service.confirm(confirmation.token, actor)).rejects.toThrow('expired');
      await expect(service.validateConfirmation(confirmation.token, actor)).rejects.toThrow(
        'expired',
      );
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
      expect(await connection.collection('archive_control_confirmations').countDocuments()).toBe(1);
      const newConfirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      expect((await service.confirm(newConfirmation.token, actor)).status).toBe('queued');
    }));

  it('removes a queued replay inserted after purge marked the consumed receipt', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      await service.confirm(confirmation.token, actor);
      const jobs = connection.collection('archive_jobs');
      const originalUpdate = jobs.updateOne.bind(jobs);
      const update = vi.spyOn(jobs, 'updateOne').mockImplementationOnce(async (...args) => {
        await service.purgeJobs();
        return originalUpdate(...args);
      });
      await expect(service.confirm(confirmation.token, actor)).rejects.toThrow('expired');
      expect(update).toHaveBeenCalledOnce();
      expect(await jobs.countDocuments()).toBe(0);
    }));

  it('preserves a job claimed by a worker between purge selection and deletion', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(manifest() as never);
      const service = new ArchiveControlService(connection, '123');
      const confirmation = await service.requestConfirmation('apply', 'synthetic-run', actor);
      const job = await service.confirm(confirmation.token, actor);
      const confirmations = connection.collection('archive_control_confirmations');
      const originalUpdate = confirmations.updateMany.bind(confirmations);
      vi.spyOn(confirmations, 'updateMany').mockImplementationOnce(async (...args) => {
        await connection
          .collection('archive_jobs')
          .updateOne(
            { jobId: job.jobId },
            { $set: { status: 'running', claimToken: 'worker-claim' } },
          );
        return originalUpdate(...args);
      });
      expect(await service.purgeJobs()).toEqual({ deleted: 0, running: 1 });
      expect(await service.confirm(confirmation.token, actor)).toMatchObject({
        jobId: job.jobId,
        status: 'running',
        cancelRequested: false,
      });
    }));

  it('paginates jobs deterministically and defaults to active jobs with scoped autocomplete', async () =>
    withFreshConnection(async (connection) => {
      const service = new ArchiveControlService(connection, '123');
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      const jobs = await Promise.all(Array.from({ length: 6 }, () => service.submit('audit')));
      await connection
        .collection('archive_jobs')
        .updateOne({ jobId: jobs[0]!.jobId }, { $set: { status: 'complete' } });
      await new ArchiveControlService(connection, '999').submit('audit');
      const first = await service.jobs({ limit: 2 });
      const second = await service.jobs({ limit: 2, before: first.nextCursor });
      const third = await service.jobs({ limit: 2, before: second.nextCursor });
      const ids = [...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.jobId);
      expect(new Set(ids).size).toBe(5);
      expect(third.nextCursor).toBeUndefined();
      expect((await service.jobs({ all: true })).jobs).toHaveLength(6);
      expect((await service.autocomplete('job', '.*')).length).toBe(0);
      expect(await service.autocomplete('job', '123:', 'cancel')).toHaveLength(5);
      await expect(service.jobs({ limit: 26 })).rejects.toThrow();
      await expect(service.jobs({ before: '999:foreign' })).rejects.toThrow();
    }));

  it('exposes only eligible run suggestions and validates attachment scope and mutation boundaries', async () =>
    withFreshConnection(async (connection) => {
      await connection
        .collection('archive_repair_runs')
        .insertMany([
          manifest(),
          manifest({ _id: 'accepted-run', status: 'accepted' }),
          manifest({ _id: 'foreign-run', guildId: '999' }),
        ] as never);
      const service = new ArchiveControlService(connection, '123');
      expect(await service.autocomplete('run', '', 'apply')).toEqual([
        { name: 'planned synthetic-run', value: 'synthetic-run', status: 'planned', createdAt: 1 },
      ]);
      await expect(service.requestConfirmation('accept', 'synthetic-run', actor)).rejects.toThrow(
        'eligible',
      );
      await expect(service.submit('apply' as never)).rejects.toThrow();
      await expect(service.submit('refresh-attachment', { channelId: '123' })).rejects.toThrow(
        'scope',
      );
      const refresh = await service.submit('refresh-attachment', {
        channelId: '789',
        messageId: '111',
        attachmentId: '222',
        userId: '456',
      });
      expect(
        await connection.collection('archive_jobs').findOne({ jobId: refresh.jobId }),
      ).toMatchObject({
        options: { channelId: '789', messageId: '111', attachmentId: '222', userId: '456' },
      });
      expect(await service.periodicStatus()).toBeNull();
      await connection.collection('archive_periodic_runs').insertOne({
        _id: 'current',
        runId: 'periodic:123',
        status: 'partial',
        cutoff: 123,
        full: true,
        result: { counts: { messages: 5 }, issues: ['Missing coverage: private secret'] },
        error: { content: 'private secret' },
      } as never);
      expect(JSON.stringify(await service.periodicStatus())).not.toContain('private');
    }));
});
