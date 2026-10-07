import { afterEach, describe, expect, it, vi } from 'vitest';
import { mongo } from 'mongoose';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { withFreshConnection } from '../helpers/mongo';

const runId = '12345678-1234-1234-1234-123456789012';
const run = (operations: number) => ({
  _id: runId,
  guildId: '123',
  status: 'planned',
  schemaHash: 'archive-v2',
  createdAt: 1,
  cutoff: 2,
  validUntil: Date.now() + 60_000,
  operations,
  journalBytes: 100,
  issues: [],
});
const operation = (sequence: number, patch: Record<string, unknown> = {}) => ({
  _id: `information-${sequence}`,
  runId,
  sequence,
  collection: 'fetches',
  documentId: String(1001 + sequence),
  reason: 'reset-cursor-for-full-reconciliation',
  state: 'planned',
  before: {
    channelID: '111',
    channel: 'recorded-name',
    lastMessageID: '900',
    content: 'private-body',
  },
  after: { channelID: '111', channel: 'recorded-name', lastMessageID: '', content: 'private-body' },
  beforeHash: 'a'.repeat(64),
  afterHash: 'b'.repeat(64),
  dependencies: [],
  ...patch,
});
afterEach(() => vi.restoreAllMocks());

describe('archive information queries', () => {
  it('counts complete grouped filters, deduplicates sources and bounds examples and state counters', async () =>
    withFreshConnection(async (connection) => {
      const resets = Array.from({ length: 12 }, (_, sequence) => {
        const channelID = ['111', '222', '333', '444'][sequence % 4];
        const image = {
          channelID,
          channel: 'same-name',
          lastMessageID: '900',
          content: 'private-body',
          attachments: [{ url: 'signed-secret' }],
        };
        return operation(sequence, {
          state: sequence < 2 ? 'verified' : 'planned',
          before: image,
          after: { ...image, lastMessageID: '' },
        });
      });
      const rows = [
        ...resets,
        operation(12, {
          reason: 'delete-duplicate-cursor',
          state: 'conflict',
          after: null,
          dependencies: ['information-0'],
        }),
        operation(13, {
          reason: 'delete-duplicate-cursor',
          after: null,
          dependencies: ['information-12'],
        }),
        operation(14, {
          collection: 'messages',
          reason: 'policy-excluded-source',
          before: {
            channelId: '111',
            messageId: '555',
            channelName: 'recorded-name',
            content: 'private-body',
          },
          after: null,
        }),
        operation(15, {
          collection: 'archive_reactions',
          reason: 'policy-excluded-related-record',
          before: { messageId: '555', userIds: ['secret-user'] },
          after: null,
        }),
        operation(16, {
          collection: 'archive_quarantine',
          reason: 'preserve-quarantine-evidence',
          before: null,
          after: {
            reason: 'duplicate-conflict',
            snapshot: {
              channelId: '333',
              channelName: 'thread-history',
              channelType: 11,
              parentId: '777',
              messageId: '666',
              content: 'private-body',
            },
          },
        }),
        operation(17, {
          collection: 'messages',
          reason: 'future-repair',
          before: { channelId: '111' },
          after: { channelId: '222' },
        }),
      ];
      await connection.collection('archive_repair_runs').insertOne(run(rows.length) as never);
      await connection.collection('archive_repair_operations').insertMany(rows as never);
      const service = new ArchiveControlService(connection, '123');
      const summary = await service.manifestSummary(runId);
      expect(summary).toMatchObject({
        status: 'available',
        totalOperations: 18,
        targets: { distinctSources: 4, unknownSourceOperations: 2 },
      });
      if (summary.status !== 'available') throw new Error('Expected summary');
      expect(summary.recordTypes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            collection: 'fetches',
            operations: 14,
            sourceCount: 4,
            deleteOperations: 2,
          }),
          expect.objectContaining({ collection: 'messages', operations: 2, deleteOperations: 1 }),
          expect.objectContaining({
            collection: 'archive_reactions',
            operations: 1,
            deleteOperations: 1,
            unknownSourceOperations: 1,
          }),
        ]),
      );
      const aggregate = vi.spyOn(connection.collection('archive_repair_operations'), 'aggregate');
      const grouped = await service.manifestGroups(runId, { category: 'reset-progress', limit: 1 });
      expect(grouped).toMatchObject({
        status: 'available',
        totalOperations: 12,
        hasNext: false,
        hasPrevious: false,
        groups: [
          {
            operations: 12,
            sourceCount: 4,
            unknownSourceOperations: 0,
            states: { planned: 10, verified: 2 },
          },
        ],
      });
      if (grouped.status !== 'available') throw new Error('Expected groups');
      const group = grouped.groups[0];
      expect(group?.examples.map((target) => target.channelId)).toEqual(['111', '222', '333']);
      expect(group?.examples).toHaveLength(3);
      const first = await service.manifestSources(runId, { group, limit: 2 });
      expect(first).toMatchObject({
        status: 'available',
        totalOperations: 12,
        hasNext: true,
        hasPrevious: false,
        nextCursor: '222',
        sources: [
          { sourceId: '111', operations: 3 },
          { sourceId: '222', operations: 3 },
        ],
      });
      if (first.status !== 'available') throw new Error('Expected sources');
      const second = await service.manifestSources(runId, {
        group,
        afterSource: first.nextCursor,
        limit: 2,
      });
      expect(second).toMatchObject({
        status: 'available',
        totalOperations: 12,
        hasNext: false,
        hasPrevious: true,
        previousCursor: '333',
        sources: [{ sourceId: '333' }, { sourceId: '444' }],
      });
      if (second.status !== 'available') throw new Error('Expected sources');
      const back = await service.manifestSources(runId, {
        group,
        beforeSource: second.previousCursor,
        limit: 2,
      });
      expect(back).toEqual(first);
      const source = await service.manifest(runId, { group, sourceId: '333', limit: 2 });
      expect(source.operations.map((entry) => entry.sequence)).toEqual([2, 6]);
      const next = await service.manifest(runId, {
        group,
        sourceId: '333',
        afterSequence: source.nextCursor,
        limit: 2,
      });
      expect(next.operations.map((entry) => entry.sequence)).toEqual([10]);
      const unknown = await service.manifestSources(runId, { category: 'exclude-by-policy' });
      expect(unknown).toMatchObject({
        status: 'available',
        totalOperations: 2,
        sources: [{ sourceId: '111' }, { sourceId: 'unknown', target: { identity: 'unknown' } }],
      });
      expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
        maxTimeMS: 5000,
        allowDiskUse: false,
      });
      expect(JSON.stringify({ grouped, first, source, unknown })).not.toMatch(
        /private-body|signed-secret|secret-user/,
      );
    }));

  it('navigates stable group cursors and rejects cross-guild reads and invalid directions', async () =>
    withFreshConnection(async (connection) => {
      const rows = [
        operation(0),
        operation(1, { reason: 'delete-duplicate-cursor', after: null }),
        operation(2, {
          collection: 'messages',
          reason: 'rescue-timestamp',
          before: { channelId: '111', timestamp: '123' },
          after: { channelId: '111', timestamp: 123 },
        }),
      ];
      await connection.collection('archive_repair_runs').insertOne(run(rows.length) as never);
      await connection.collection('archive_repair_operations').insertMany(rows as never);
      const service = new ArchiveControlService(connection, '123');
      const first = await service.manifestGroups(runId, { limit: 1 });
      expect(first).toMatchObject({ totalOperations: 3, hasPrevious: false, hasNext: true });
      if (first.status !== 'available') throw new Error('Expected groups');
      const second = await service.manifestGroups(runId, {
        afterGroup: first.nextCursor,
        limit: 1,
      });
      if (second.status !== 'available') throw new Error('Expected groups');
      const back = await service.manifestGroups(runId, {
        beforeGroup: second.previousCursor,
        limit: 1,
      });
      expect(back).toEqual(first);
      await expect(
        service.manifestGroups(runId, {
          afterGroup: first.nextCursor,
          beforeGroup: second.previousCursor,
        }),
      ).rejects.toThrow('one direction');
      await expect(
        service.manifestSources(runId, { afterSource: '111', beforeSource: '222' }),
      ).rejects.toThrow('one direction');
      await expect(
        new ArchiveControlService(connection, '999').manifestGroups(runId),
      ).rejects.toThrow('Unknown');
      await expect(
        new ArchiveControlService(connection, '999').manifestSources(runId),
      ).rejects.toThrow('Unknown');
      await expect(
        new ArchiveControlService(connection, '999').operation(runId, 0),
      ).rejects.toThrow('Unknown');
      const detail = await service.operation(runId, 2);
      expect(detail.operation.changes).toEqual([
        {
          field: 'timestamp',
          before: { state: 'value', value: 123, storageType: 'string' },
          after: { state: 'value', value: 123, storageType: 'number' },
        },
      ]);
    }));

  it('provides safe targets and differences and proves survivor relationships without collection collisions', async () =>
    withFreshConnection(async (connection) => {
      const rows = [
        operation(0),
        operation(1, {
          reason: 'delete-duplicate-cursor',
          after: null,
          dependencies: ['information-0', 'missing-operation'],
        }),
        operation(2, {
          collection: 'messages',
          reason: 'delete-verified-duplicate',
          before: { channelId: '111', content: 'private-body' },
          after: null,
          dependencies: ['information-0'],
        }),
        operation(3, {
          reason: 'delete-duplicate-cursor',
          after: null,
          dependencies: ['information-1'],
        }),
        operation(4, {
          before: { channelID: '111', channel: 'long-name'.repeat(40) },
          after: { channelID: '111', lastMessageID: '' },
        }),
        operation(5, {
          collection: 'archive_quarantine',
          reason: 'preserve-quarantine-evidence',
          before: null,
          after: {
            reason: 'duplicate-conflict',
            snapshot: {
              channelId: '333',
              channelName: 'thread-history',
              channelType: 11,
              parentId: '777',
              messageId: '666',
              content: 'private-body',
            },
          },
        }),
      ];
      await connection.collection('archive_repair_runs').insertOne(run(rows.length) as never);
      await connection.collection('archive_repair_operations').insertMany(rows as never);
      await connection.collection('fetches').insertMany([
        { _id: '1001', channelID: '111' },
        { _id: '1002', channelID: '111' },
        { _id: '1004', channelID: '111' },
      ] as never);
      const service = new ArchiveControlService(connection, '123');
      const detail = await service.operation(runId, 1);
      expect(detail.operation).toMatchObject({
        target: { identity: 'known', channelId: '111', historicalName: 'recorded-name' },
        changes: [],
        survivorStatus: 'verified',
        survivor: {
          documentId: '1001',
          operationId: 'information-0',
          sequence: 0,
          evidence: 'dependency',
        },
        dependencyReferences: [
          { operationId: 'information-0', state: 'known', sequence: 0 },
          { operationId: 'missing-operation', state: 'missing' },
        ],
      });
      const reset = await service.operation(runId, 0);
      expect(reset.operation.changes).toEqual([
        {
          field: 'lastMessageId',
          before: { state: 'value', value: '900' },
          after: { state: 'unset' },
        },
      ]);
      const unrelated = await service.operation(runId, 2);
      expect(unrelated.operation.survivorStatus).toBe('unavailable');
      expect(unrelated.operation.survivor).toBeUndefined();
      const retained = await service.operation(runId, 3);
      expect(retained.operation.survivor).toEqual({
        documentId: '1001',
        evidence: 'retained-record',
      });
      const legacy = await service.operation(runId, 4);
      expect(legacy.operation.changes[0]?.before.state).toBe('unknown');
      expect(legacy.operation.target.historicalName?.length).toBe(100);
      const quarantine = await service.operation(runId, 5);
      expect(quarantine.operation).toMatchObject({
        target: { channelId: '333', messageId: '666', parentId: '777' },
        quarantineReason: 'duplicate-conflict',
      });
      expect(JSON.stringify(detail)).not.toContain('private-body');
      await expect(service.operation(runId, 500)).rejects.toThrow('Unknown');
      vi.spyOn(connection.collection('fetches'), 'aggregate').mockImplementation(() => {
        throw new mongo.MongoServerError({ code: 50, message: 'private failure' });
      });
      expect((await service.operation(runId, 3)).operation.survivorStatus).toBe('unavailable');
    }));

  it('does not invent zero counts after group/source query failures', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(run(0) as never);
      const service = new ArchiveControlService(connection, '123');
      vi.spyOn(connection.collection('archive_repair_operations'), 'aggregate').mockImplementation(
        () => {
          throw new mongo.MongoServerError({ code: 50, message: 'private failure' });
        },
      );
      for (const page of [
        await service.manifestGroups(runId),
        await service.manifestSources(runId),
      ]) {
        expect(page).toMatchObject({
          status: 'unavailable',
          reason: 'timeout',
          hasNext: false,
          hasPrevious: false,
        });
        expect(page).not.toHaveProperty('totalOperations');
        expect(JSON.stringify(page)).not.toContain('private failure');
      }
    }));

  it('propagates quarantine reasons only from matching source-collection and record evidence', async () =>
    withFreshConnection(async (connection) => {
      const snapshot = {
        _id: '3001',
        channelId: '111',
        messageId: '555',
        content: 'private-body',
        userIds: ['private-user'],
      };
      const evidence = (sequence: number, after: Record<string, unknown>) =>
        operation(sequence, {
          collection: 'archive_quarantine',
          documentId: String(9000 + sequence),
          reason: 'preserve-quarantine-evidence',
          before: null,
          after,
        });
      const moved = (sequence: number, dependency: number) =>
        operation(sequence, {
          collection: 'messages',
          documentId: '3001',
          reason: 'relocate-to-quarantine',
          before: snapshot,
          after: null,
          dependencies: [`information-${dependency}`],
        });
      const cursor = { _id: '4001', channelID: 'invalid', content: 'private-body' };
      const rows = [
        evidence(0, {
          sourceId: '3001',
          reason: 'timestamp-unrecoverable',
          messageId: '555',
          snapshot,
        }),
        moved(1, 0),
        evidence(2, {
          sourceId: '4001',
          sourceCollection: 'fetches',
          reason: 'invalid-channel-cursor',
          snapshot: cursor,
        }),
        operation(3, {
          documentId: '4001',
          reason: 'quarantine-invalid-cursor',
          before: cursor,
          after: null,
          dependencies: ['information-2'],
        }),
        evidence(4, {
          sourceId: '3001',
          sourceCollection: 'fetches',
          reason: 'invalid-channel-cursor',
          snapshot,
        }),
        moved(5, 4),
        evidence(6, {
          sourceId: '3002',
          reason: 'wrong-record',
          snapshot: { ...snapshot, _id: '3002' },
        }),
        moved(7, 6),
        evidence(8, {
          sourceId: '3001',
          reason: 'missing-message-identity',
          snapshot: { _id: '3001', channelId: '111' },
        }),
        moved(9, 8),
        evidence(10, { sourceId: '3001', reason: 'conflicting userId', snapshot }),
        moved(11, 10),
      ];
      await connection.collection('archive_repair_runs').insertOne(run(rows.length) as never);
      await connection.collection('archive_repair_operations').insertMany(rows as never);
      const control = new ArchiveControlService(connection, '123');
      expect((await control.operation(runId, 1)).operation.quarantineReason).toBe(
        'timestamp-unrecoverable',
      );
      expect((await control.operation(runId, 3)).operation.quarantineReason).toBe(
        'invalid-channel-cursor',
      );
      expect((await control.operation(runId, 11)).operation.quarantineReason).toBe(
        'conflicting-user-id',
      );
      for (const sequence of [5, 7, 9])
        expect(
          (await control.operation(runId, sequence)).operation.quarantineReason,
        ).toBeUndefined();
      expect(JSON.stringify(await control.operation(runId, 1))).not.toMatch(
        /private-body|private-user|sourceCollection|snapshot/,
      );
    }));

  it('displays exclusion policy evidence only for the saved run hash and an explicit rejection', async () =>
    withFreshConnection(async (connection) => {
      const policyHash = 'c'.repeat(64);
      const evidence = (patch: Record<string, unknown>) => ({
        policyHash,
        admitted: false,
        reason: 'rule-exclude',
        ruleId: 'explicit-denial',
        ...patch,
      });
      const decisions = [
        evidence({ admitted: true, reason: 'rule-include', ruleId: 'prior-admission' }),
        evidence({ policyHash: 'd'.repeat(64) }),
        evidence({}),
        evidence({ reason: 'bot-not-allowlisted', ruleId: 'not-an-exclusion-rule' }),
        evidence({ reason: 'private-body' }),
        evidence({ reason: 'webhook-not-allowlisted', ruleId: 'not-an-exclusion-rule' }),
        undefined,
      ];
      await connection
        .collection('archive_repair_runs')
        .insertOne({ ...run(decisions.length), policyHash } as never);
      await connection.collection('archive_repair_operations').insertMany(
        decisions.map((decision, sequence) =>
          operation(sequence, {
            collection: 'messages',
            reason: 'policy-excluded-source',
            before: {
              channelId: '111',
              messageId: '555',
              content: 'private-body',
              policy: { ruleId: 'prior-admission', reason: 'rule-include' },
              ...(decision === undefined ? {} : { archiveSourceDecision: decision }),
            },
            after: null,
          }),
        ) as never,
      );
      const control = new ArchiveControlService(connection, '123');
      const page = await control.manifest(runId);
      const projected = page.operations.map((entry) => [entry.policyReason, entry.policyRuleId]);
      expect(projected).toEqual([
        [undefined, undefined],
        [undefined, undefined],
        ['rule-exclude', 'explicit-denial'],
        ['bot-not-allowlisted', undefined],
        [undefined, undefined],
        ['webhook-not-allowlisted', undefined],
        [undefined, undefined],
      ]);
      expect(JSON.stringify(page)).not.toMatch(
        /prior-admission|not-an-exclusion-rule|private-body/,
      );
    }));

  it('paginates every legacy activity and source gap as a bounded entry without omission', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_progress_details').insertMany([
        ...['111', '222', '333'].map((sourceId) => ({
          guildId: '123',
          scopeId: 'progress-run',
          sourceId,
          activity: {
            sourceId,
            name: `source-${sourceId}`,
            step: 'fetching',
            scanned: 3,
            content: 'private-body',
          },
          gaps: ['permission', 'capacity'].map((reason) => ({
            sourceId,
            name: `source-${sourceId}`,
            reason,
            userIds: ['private-user'],
          })),
        })),
        {
          guildId: '999',
          scopeId: 'progress-run',
          sourceId: '000',
          gaps: [{ sourceId: '000', reason: 'permission', name: 'foreign-source' }],
        },
      ]);
      const control = new ArchiveControlService(connection, '123');
      const aggregate = vi.spyOn(connection.collection('archive_progress_details'), 'aggregate');
      const activities: string[] = [];
      const gaps: string[] = [];
      let hasNext = true;
      let page = 1;
      while (hasNext) {
        const result = await control.progressDetails('progress-run', page++, 3);
        expect(result.activities.length + result.gaps.length).toBeLessThanOrEqual(3);
        activities.push(...result.activities.map((activity) => activity.sourceId));
        gaps.push(...result.gaps.map((gap) => `${gap.sourceId}:${gap.reason}`));
        expect(JSON.stringify(result)).not.toMatch(/private-body|private-user|foreign-source/);
        hasNext = result.hasNext;
      }
      expect(page).toBe(4);
      expect(activities).toEqual(['111', '222', '333']);
      expect(gaps).toEqual([
        '111:permission',
        '111:capacity',
        '222:permission',
        '222:capacity',
        '333:permission',
        '333:capacity',
      ]);
      expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
        maxTimeMS: 5000,
        allowDiskUse: false,
      });
      expect(await control.progressDetails('progress-run', 10, 1)).toEqual({
        page: 10,
        activities: [],
        gaps: [],
        hasNext: false,
      });
    }));

  it('invalidates confirmations when displayed identity or cursor changes despite unchanged stored hashes', async () =>
    withFreshConnection(async (connection) => {
      await connection.collection('archive_repair_runs').insertOne(run(1) as never);
      await connection.collection('archive_repair_operations').insertOne(operation(0) as never);
      const service = new ArchiveControlService(connection, '123');
      const actor = { userId: '456', channelId: '789' };
      const first = await service.requestConfirmation('apply', runId, actor);
      await connection
        .collection('archive_repair_operations')
        .updateOne(
          { runId, sequence: 0 },
          { $set: { 'before.channelID': '222', 'after.channelID': '222' } },
        );
      await expect(service.confirm(first.token, actor)).rejects.toThrow('changed');
      const second = await service.requestConfirmation('apply', runId, actor);
      await connection
        .collection('archive_repair_operations')
        .updateOne({ runId, sequence: 0 }, { $set: { 'before.lastMessageID': '901' } });
      await expect(service.confirm(second.token, actor)).rejects.toThrow('changed');
      expect(await connection.collection('archive_jobs').countDocuments()).toBe(0);
    }));
});
