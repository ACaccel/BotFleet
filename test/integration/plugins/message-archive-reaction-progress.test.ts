import path from 'node:path';
import { createDefaultTranslator } from '../../../src/core/i18n';
import { ChannelType, type Client, type Guild, type APIEmbed } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ArchiveJob } from '../../../src/core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../src/core/archive/progress';
import type * as StorageUsageModule from '../../../src/infra/archive/storage-usage';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import { createLogger } from '../../../src/core/logger';
import type { Translator } from '../../../src/core/i18n';
import { withFreshConnection } from '../helpers/mongo';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';

vi.mock('../../../src/plugins/message-backup/internal/collect-channels', () => ({
  collectChannels: vi.fn(),
}));
vi.mock('../../../src/infra/archive/storage-usage', async (original) => {
  const actual = await original<typeof StorageUsageModule>();
  return {
    ...actual,
    resolveArchiveStorageRoots: async () => ['/test'],
    measureStorageRoots: async () => ({
      usedBytes: 0,
      availableBytes: 200_000_000_000,
      measuredAt: Date.now(),
      roots: ['/test'],
    }),
  };
});
function fixture(
  manager: StaticConnectionManager,
  debug = false,
  translator?: Translator,
  progressSeconds = 10,
  discoveryPasses = true,
) {
  const channel = { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null };
  vi.mocked(collectChannels).mockResolvedValue({
    channels: [channel],
    liveChannelIds: new Set(['10']),
    gaps: [],
    complete: true,
    locations: discoveryPasses
      ? [{ id: channel.id, type: channel.type, name: channel.name, passes: ['channels'] }]
      : [],
  } as any);
  const snapshot = {
    id: '101',
    guild_id: '1',
    channel_id: '10',
    author: { id: '1000', username: 'human', bot: false },
    content: 'hello',
    timestamp: '2026-01-01T00:00:00Z',
    attachments: [],
    embeds: [],
    reactions: [
      { emoji: { id: '50', name: 'first' }, count: 3, count_details: { normal: 2, burst: 1 } },
    ],
  };
  const get = vi.fn(async (route: string, options?: { query?: URLSearchParams }) =>
    route === '/channels/10/messages/100'
      ? { embeds: [], components: [] }
      : route.includes('/reactions/')
        ? options?.query?.get('type') === '0'
          ? [{ id: '1001' }, { id: '1002' }]
          : [{ id: '1003' }]
        : route.endsWith('/messages')
          ? [snapshot]
          : snapshot,
  );
  const messages: string[] = [];
  const message = {
    id: '100',
    edit: vi.fn(async (options: { content: string }) => {
      messages.push(options.content);
      return message;
    }),
  };
  const debugChannel = {
    id: '10',
    isSendable: () => true,
    send: vi.fn(async (options: { content: string; embeds: APIEmbed[] }) => {
      messages.push(JSON.stringify(options.embeds));
      return message;
    }),
  };
  const patch = vi.fn(
    async (_route: string, options: { body: { content: string; embeds: APIEmbed[] } }) => {
      messages.push(JSON.stringify(options.body.embeds));
      return {};
    },
  );
  const client = {
    channels: { cache: new Map() },
    guilds: { fetch: async () => ({ id: '1' }) as Guild },
    rest: { get, patch },
  } as unknown as Client;
  const worker = new ArchiveWorker({
    client,
    connections: manager,
    registry: {
      getRepos: () => undefined,
      getChannel: () => (debug ? (debugChannel as any) : undefined),
      getRole: () => undefined,
      listGuildIds: () => ['1'],
    },
    config: archiveRuntimeSchema.parse({ progress_interval_seconds: progressSeconds }),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    guildIds: ['1'],
    logger: createLogger({ level: 'silent', pretty: false }),
    translator:
      translator ??
      ({
        t: (key: string, values: unknown) => JSON.stringify({ key, values }),
      } as Translator),
  });
  return { worker, get, patch, snapshot, messages, debugChannel, message };
}

describe('reaction identity and job progress integration', () => {
  it('publishes fresh empty memberships once and removes previously published references', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        await f.worker.periodic('1');
        const state = await f.worker.initialize('1');
        const previous = await connection.collection('messages').findOne({ messageId: '101' });
        expect(Object.keys(previous?.reactionGenerations ?? {})).toHaveLength(2);
        f.snapshot.reactions = [];
        f.get.mockClear();
        const stale = vi.spyOn(state.repo, 'markReactionsStale');
        const finalize = vi.spyOn(state.repo, 'finalizeReactionRefresh');
        await f.worker.periodic('1');
        expect(stale).not.toHaveBeenCalled();
        expect(finalize).not.toHaveBeenCalled();
        expect(f.get.mock.calls.some(([route]) => route.includes('/reactions/'))).toBe(false);
        const current = await connection.collection('messages').findOne({ messageId: '101' });
        expect(current?.reactionGenerations).toEqual({});
        expect(current?.reactionsFreshAt).toEqual(expect.any(Number));
        expect(current).not.toHaveProperty('reactionsStaleAt');
        expect(await connection.collection('archive_reactions').countDocuments()).toBe(2);
      } finally {
        await f.worker.stop();
      }
    }));

  it('keeps tombstones excluded when history returns an empty reaction list', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        await f.worker.periodic('1');
        const state = await f.worker.initialize('1');
        await state.repo.tombstone('101', '10', Date.now());
        f.snapshot.reactions = [];
        await f.worker.periodic('1');
        const current = await connection.collection('messages').findOne({ messageId: '101' });
        expect(current?.deletion).toBeDefined();
        const channel = (await state.repo.listChannels()).find((item) => item.channelId === '10');
        expect(channel?.checkpoint).toMatchObject({ complete: true, scanned: 1, admitted: 0 });
      } finally {
        await f.worker.stop();
      }
    }));

  it('records format upgrades separately in durable checkpoints', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        await f.worker.periodic('1');
        await connection.collection('messages').updateOne(
          { messageId: '101' },
          {
            $unset: { schemaVersion: '', contentHash: '' },
          },
        );
        await f.worker.periodic('1');
        const state = await f.worker.initialize('1');
        expect(state.progress?.snapshot().messages).toMatchObject({
          upgraded: 1,
          updated: 0,
          inserted: 0,
          durable: 1,
        });
        const channel = (await state.repo.listChannels()).find((item) => item.channelId === '10');
        expect(channel?.checkpoint).toMatchObject({
          statistics: { messageClassificationVersion: 2, messages: { upgraded: 1, updated: 0 } },
        });
        expect(
          (await connection.collection('messages').findOne({ messageId: '101' }))?.schemaVersion,
        ).toBe(2);
      } finally {
        await f.worker.stop();
      }
    }));

  it('falls back to one message when legacy image preload exceeds the byte budget', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        const get = f.get.getMockImplementation()!;
        f.get.mockImplementation(async (route, options) =>
          route.endsWith('/messages')
            ? ['103', '102', '101'].map((id) => ({ ...f.snapshot, id }))
            : get(route, options),
        );
        const state = await f.worker.initialize('1');
        vi.spyOn(state.repo, 'loadSnapshotBatch').mockRejectedValueOnce(
          new RangeError('Archive snapshot observations exceed byte limit'),
        );
        const persist = vi.spyOn(state.repo, 'persistSnapshotsBatch');
        await f.worker.periodic('1');
        expect(persist.mock.calls.map(([snapshots]) => snapshots.length)).toEqual([1, 2]);
        expect(await connection.collection('messages').countDocuments()).toBe(3);
        const channel = (await state.repo.listChannels()).find((item) => item.channelId === '10');
        expect(channel?.checkpoint).toMatchObject({ complete: true, scanned: 3, admitted: 3 });
      } finally {
        await f.worker.stop();
      }
    }));

  it.each([true, false])(
    'journals and rolls back an empty refresh with discovery passes %s',
    async (discoveryPasses) =>
      withFreshConnection(async (connection) => {
        const f = fixture(
          new StaticConnectionManager(connection),
          false,
          undefined,
          10,
          discoveryPasses,
        );
        const jobs = connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
        const execute = async (command: 'backfill' | 'apply' | 'rollback', runId?: string) => {
          const jobId = `empty-memberships-${command}`;
          await jobs.insertOne({
            _id: jobId,
            jobId,
            requestId: jobId,
            guildId: '1',
            command,
            options: {},
            status: 'queued',
            cancelRequested: false,
            createdAt: Date.now(),
            ...(runId === undefined ? {} : { runId }),
          });
          await f.worker.pollJobs('1');
          const job = await jobs.findOne({ jobId });
          expect(job?.status, JSON.stringify(job?.result)).toBe('complete');
          return job!.runId!;
        };
        try {
          await f.worker.periodic('1');
          const previous = await connection.collection('messages').findOne({ messageId: '101' });
          f.snapshot.reactions = [];
          const runId = await execute('backfill');
          await execute('apply', runId);
          expect(
            (await connection.collection('messages').findOne({ messageId: '101' }))
              ?.reactionGenerations,
          ).toEqual({});
          const journal = await connection
            .collection('archive_repair_operations')
            .find({ runId, reason: 'message-snapshot' })
            .toArray();
          expect(journal).toHaveLength(1);
          expect(journal[0]?.after.reactionGenerations).toEqual({});
          expect(
            await connection.collection('archive_repair_operations').countDocuments({
              runId,
              reason: 'reaction-refresh-complete',
            }),
          ).toBe(0);
          expect(
            await connection
              .collection('archive_repair_operations')
              .countDocuments({ runId, reason: 'reaction-stale' }),
          ).toBe(0);
          await execute('rollback', runId);
          const restored = await connection.collection('messages').findOne({ messageId: '101' });
          expect(restored?.reactionGenerations).toEqual(previous?.reactionGenerations);
          expect(restored?.reactionsFreshAt).toEqual(previous?.reactionsFreshAt);
          expect(await connection.collection('archive_reactions').countDocuments()).toBe(2);
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it('pauses an active one-shot scan and resumes its original cutoff without losing archived data', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      const control = new ArchiveControlService(connection, '1');
      const jobs = connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
      const execute = async (command: 'backfill' | 'apply' | 'resume', runId?: string) => {
        const jobId = `pause-test-${command}`;
        await jobs.insertOne({
          _id: jobId,
          jobId,
          requestId: jobId,
          guildId: '1',
          command,
          options: {},
          status: 'queued',
          cancelRequested: false,
          createdAt: Date.now(),
          ...(runId === undefined ? {} : { runId }),
        });
        await f.worker.pollJobs('1');
        return (await jobs.findOne({ jobId }))!;
      };
      try {
        const planned = await execute('backfill');
        expect(planned.status).toBe('complete');
        const runId = planned.runId!;
        const runs = connection.collection<{ _id: string; cutoff: number }>('archive_repair_runs');
        const before = await runs.findOne({ _id: runId });
        const get = f.get.getMockImplementation()!;
        let paused = false;
        f.get.mockImplementation(async (route, options) => {
          if (route.includes('/reactions/') && !paused) {
            paused = true;
            await control.pauseRun(runId, 'pause-test-apply');
            // Let the bounded cancellation observation expire while the request remains in flight.
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return get(route, options);
        });
        const stopped = await execute('apply', runId);
        expect(stopped.status).toBe('cancelled');
        expect(await connection.collection('messages').countDocuments({ messageId: '101' })).toBe(
          1,
        );
        expect(
          await connection.collection('archive_repair_operations').countDocuments({ runId }),
        ).toBeGreaterThan(0);
        const state = await f.worker.initialize('1');
        const interrupted = (await state.repo.listChannels()).find(
          (channel) => channel.channelId === '10',
        );
        expect(interrupted?.checkpoint).toMatchObject({
          runId,
          cutoff: before!.cutoff,
          complete: false,
          scanned: 0,
        });
        expect((await control.manifest(runId)).run.actions).toContain('resume');
        f.get.mockImplementation(get);
        const resumed = await execute('resume', runId);
        expect(resumed.status, JSON.stringify(resumed.result)).toBe('complete');
        const finished = (await state.repo.listChannels()).find(
          (channel) => channel.channelId === '10',
        );
        expect(finished?.checkpoint).toMatchObject({
          runId,
          cutoff: before!.cutoff,
          complete: true,
          scanned: 1,
        });
        expect(await connection.collection('messages').countDocuments({ messageId: '101' })).toBe(
          1,
        );
        expect((await runs.findOne({ _id: runId }))?.cutoff).toBe(before!.cutoff);
        expect(state.progress?.snapshot().messageCountQuality).toBe('lower-bound');
        expect(finished?.checkpoint).toMatchObject({ statistics: { countQuality: 'lower-bound' } });
      } finally {
        await f.worker.stop();
      }
    }));

  it.each(['dirty', 'gap', 'cancel'] as const)(
    'preserves published memberships when %s invalidates an empty refresh before batch issuance',
    async (change) =>
      withFreshConnection(async (connection) => {
        const f = fixture(new StaticConnectionManager(connection));
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let queued!: () => void;
        const publicationQueued = new Promise<void>((resolve) => {
          queued = resolve;
        });
        let running: Promise<void> | undefined;
        try {
          await f.worker.periodic('1');
          const state = await f.worker.initialize('1');
          const previous = await connection.collection('messages').findOne({ messageId: '101' });
          f.snapshot.reactions = [];
          const persist = state.repo.persistSnapshotsBatch.bind(state.repo);
          vi.spyOn(state.repo, 'persistSnapshotsBatch').mockImplementation(async (...args) => {
            queued();
            await blocked;
            return persist(...args);
          });
          const finalize = vi.spyOn(state.repo, 'finalizeReactionRefresh');
          running = f.worker.periodic('1');
          await publicationQueued;
          expect(state.writer.snapshot().pending).toBe(1);
          // Prevent a later verification sweep from obtaining new evidence and repairing the race.
          f.get.mockRejectedValue(new Error('Source temporarily unavailable'));
          if (change === 'dirty') state.dirty.set('101', (state.dirty.get('101') ?? 0) + 1);
          else if (change === 'gap') state.gapVersion += 1;
          else state.periodicAbort!.abort();
          release();
          await running;
          expect(finalize).not.toHaveBeenCalled();
          const current = await connection.collection('messages').findOne({ messageId: '101' });
          expect(current?.reactionGenerations).toEqual(previous?.reactionGenerations);
          expect(current?.reactionsFreshAt).toEqual(previous?.reactionsFreshAt);
          const channel = (await state.repo.listChannels()).find(
            (value) => value.channelId === '10',
          );
          expect(channel?.checkpoint).toMatchObject({
            complete: false,
            scanned: 0,
            pageSequence: 0,
          });
        } finally {
          release();
          await running;
          await f.worker.stop();
        }
      }),
  );

  it.each(['dirty', 'gap'] as const)(
    'does not publish empty evidence invalidated by a %s change',
    async (change) =>
      withFreshConnection(async (connection) => {
        const f = fixture(new StaticConnectionManager(connection));
        f.snapshot.reactions = [];
        const state = await f.worker.initialize('1');
        const persist = state.repo.persistSnapshotsBatch.bind(state.repo);
        vi.spyOn(state.repo, 'persistSnapshotsBatch').mockImplementation(async (...args) => {
          if (change === 'dirty') state.dirty.set('101', (state.dirty.get('101') ?? 0) + 1);
          else state.gapVersion += 1;
          return persist(...args);
        });
        const finalize = vi.spyOn(state.repo, 'finalizeReactionRefresh');
        try {
          await f.worker.periodic('1');
          expect(finalize).not.toHaveBeenCalled();
          const current = await connection.collection('messages').findOne({ messageId: '101' });
          expect(current?.reactionsFreshAt).toBeUndefined();
          const channel = (await state.repo.listChannels()).find(
            (value) => value.channelId === '10',
          );
          expect(channel?.checkpoint).toMatchObject({
            scanned: 0,
            pageSequence: 0,
            complete: false,
          });
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it('reports staged reaction pages before the message checkpoint completes', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      f.snapshot.reactions[0]!.count = 101;
      f.snapshot.reactions[0]!.count_details = { normal: 101, burst: 0 };
      const state = await f.worker.initialize('1');
      const observed: ArchiveProgressSnapshot[] = [];
      const originalGet = f.get.getMockImplementation()!;
      f.get.mockImplementation(async (route, options) => {
        if (route.includes('/reactions/') && options?.query?.get('type') === '0') {
          if (options.query.get('after')) {
            observed.push(state.progress!.snapshot());
            return [{ id: '1101' }];
          }
          return Array.from({ length: 100 }, (_, index) => ({ id: String(1001 + index) }));
        }
        return originalGet(route, options);
      });
      const finalize = state.repo.finalizeReactionRefresh.bind(state.repo);
      vi.spyOn(state.repo, 'finalizeReactionRefresh').mockImplementation(async (...args) => {
        observed.push(state.progress!.snapshot());
        return finalize(...args);
      });
      try {
        await f.worker.periodic('1');
        expect(observed[0]?.activities[0]).toMatchObject({
          step: 'reactions',
          reactionUsers: 100,
          reactionPages: 1,
        });
        expect(observed.at(-1)?.activities[0]).toMatchObject({
          step: 'reactions',
          reactionUsers: 101,
          reactionPages: 2,
        });
        expect(observed[0]?.messages.durable).toBe(0);
      } finally {
        await f.worker.stop();
      }
    }));

  it.each(['zh-TW', 'en'] as const)('renders real debug-channel progress in %s', async (locale) =>
    withFreshConnection(async (connection) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const f = fixture(new StaticConnectionManager(connection), true, translator);
      try {
        await f.worker.periodic('1');
        expect(f.messages.length).toBeGreaterThan(0);
        for (const content of f.messages) {
          expect(content).not.toMatch(/archive\.|replies:|\{\{/);
        }
        expect(f.messages[0]).toContain(locale === 'zh-TW' ? '執行中' : 'Running');
        expect(f.messages.at(-1)).toContain(locale === 'zh-TW' ? '已完成' : 'Complete');
        expect(f.messages.at(-1)).not.toContain(locale === 'zh-TW' ? '預估剩餘' : 'Remaining time');
        expect(f.messages.at(-1)).toContain(
          translator.t('replies:archive.public_classified_writes', {
            inserted: 1,
            updated: 0,
            upgraded: 0,
          }),
        );
        expect(f.messages.at(-1)).toContain(translator.t('replies:archive.view_periodic_scope'));
        const saved = await connection
          .collection<{ _id: string; progress: ArchiveProgressSnapshot }>('archive_periodic_runs')
          .findOne({ _id: 'current' });
        expect(saved?.progress.messages.durable).toBe(1);
        expect(f.debugChannel.send).toHaveBeenCalledTimes(1);
        expect(f.patch).toHaveBeenCalled();
      } finally {
        await f.worker.stop();
      }
    }),
  );

  it('publishes audit progress and completion with a ten-second notification interval', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection), true, undefined, 10);
      const jobs = connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
      await jobs.insertOne({
        _id: '1:audit-five-seconds',
        jobId: '1:audit-five-seconds',
        requestId: 'audit-five-seconds',
        guildId: '1',
        command: 'audit',
        options: {},
        status: 'queued',
        cancelRequested: false,
        createdAt: Date.now(),
        notification: { channelId: '10' },
      });
      try {
        await f.worker.pollJobs('1');
        expect(f.debugChannel.send).toHaveBeenCalledOnce();
        expect(f.messages[0]).toContain('view_work_audit');
        expect(f.messages.at(-1)).toContain('view_state_complete');
        expect(await jobs.findOne({ jobId: '1:audit-five-seconds' })).toMatchObject({
          status: 'complete',
          notification: { messageId: '100', deliveredStatus: 'complete' },
        });
      } finally {
        await f.worker.stop();
      }
    }));

  it('edits the submitted job message and recovers a missed final notification after restart', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager, true);
      const jobs = connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
      await jobs.insertOne({
        _id: '1:audit-notify',
        jobId: '1:audit-notify',
        requestId: 'audit-notify',
        guildId: '1',
        command: 'audit',
        options: {},
        status: 'queued',
        cancelRequested: false,
        createdAt: Date.now(),
        notification: { channelId: '10', messageId: '100' },
      });
      try {
        await first.worker.pollJobs('1');
        const saved = await jobs.findOne({ jobId: '1:audit-notify' });
        expect(saved).toMatchObject({
          status: 'complete',
          notification: {
            channelId: '10',
            messageId: '100',
            deliveredStatus: 'complete',
          },
        });
        expect(saved?.result?.counts).toHaveProperty('total');
        expect(first.debugChannel.send).not.toHaveBeenCalled();
        expect(first.patch).toHaveBeenCalled();
        expect(first.messages.at(-1)).toContain('view_state_complete');
        await jobs.updateOne(
          { jobId: '1:audit-notify' },
          { $set: { 'notification.deliveredStatus': 'running' } },
        );
      } finally {
        await first.worker.stop();
      }
      const restarted = fixture(manager, true);
      try {
        await restarted.worker.pollJobs('1');
        expect(restarted.patch).toHaveBeenCalledWith(
          '/channels/10/messages/100',
          expect.anything(),
        );
        expect(restarted.debugChannel.send).not.toHaveBeenCalled();
        expect(await jobs.findOne({ jobId: '1:audit-notify' })).toMatchObject({
          status: 'complete',
          notification: { deliveredStatus: 'complete' },
        });
      } finally {
        await restarted.worker.stop();
      }
    }));

  it('persists canonical custom emoji identity separately from normal/burst and survives renames', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        await f.worker.periodic('1');
        let chunks = await connection
          .collection('archive_reactions')
          .find({ messageId: '101' })
          .toArray();
        expect(chunks.map((chunk) => [chunk.emojiKey, chunk.type, chunk.userIds])).toEqual(
          expect.arrayContaining([
            ['custom:50', 0, ['1001', '1002']],
            ['custom:50', 1, ['1003']],
          ]),
        );
        f.snapshot.reactions[0]!.emoji.name = 'renamed';
        await f.worker.periodic('1');
        chunks = await connection
          .collection('archive_reactions')
          .find({ messageId: '101' })
          .toArray();
        expect(new Set(chunks.map((chunk) => chunk.emojiKey))).toEqual(new Set(['custom:50']));
      } finally {
        await f.worker.stop();
      }
    }));
  it('edits one durable status message and removes terminal ETA; notification failure is isolated', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection), true);
      try {
        await f.worker.periodic('1');
        expect(f.debugChannel.send).toHaveBeenCalledTimes(1);
        expect(f.patch).toHaveBeenCalled();
        expect(f.messages.at(-1)).not.toContain('view_eta');
        f.debugChannel.send.mockRejectedValueOnce(new Error('notification forbidden'));
        await f.worker.periodic('1');
        expect(await connection.collection('messages').countDocuments()).toBe(1);
      } finally {
        await f.worker.stop();
      }
    }));
  it('cancels a submitted repair scan without cancelling subsequent periodic work', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        const state = await f.worker.initialize('1');
        await connection.collection('archive_jobs').insertOne({
          jobId: 'cancelled-job',
          requestId: 'request',
          guildId: '1',
          command: 'backfill',
          options: {},
          status: 'running',
          cancelRequested: true,
          createdAt: Date.now(),
        });
        const result = await (f.worker as any).scanRun(state, 'repair-run', Date.now(), true, {
          jobId: 'cancelled-job',
          runId: 'repair-run',
          cutoff: Date.now(),
          applyMutation: async () => undefined,
        });
        expect(result.status).toBe('cancelled');
        expect(f.get).not.toHaveBeenCalled();
        await f.worker.periodic('1');
        expect(await connection.collection('messages').countDocuments()).toBe(1);
      } finally {
        await f.worker.stop();
      }
    }));
});
