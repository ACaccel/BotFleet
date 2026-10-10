import { ArchiveScheduleStore } from '../../../src/infra/archive/schedule';
import type * as StorageModule from '../../../src/infra/archive/storage-usage';
import { type Client, type Guild, ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import type { ArchiveJob } from '../../../src/core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../src/core/archive/progress';
import { createLogger } from '../../../src/core/logger';
import type { Translator } from '../../../src/core/i18n';
import { withFreshConnection } from '../helpers/mongo';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';

vi.mock('../../../src/plugins/message-backup/internal/collect-channels', () => ({
  collectChannels: vi.fn(),
}));
vi.mock('../../../src/infra/archive/storage-usage', async (original) => {
  const actual = await original<typeof StorageModule>();
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
const rawMessage = () => ({
  id: '101',
  guild_id: '1',
  channel_id: '10',
  author: { id: '1000', username: 'human', bot: false },
  content: 'hello',
  timestamp: '2020-01-01T00:00:00Z',
  attachments: [],
  embeds: [],
  reactions: [],
});
const fixture = (
  manager: StaticConnectionManager,
  read: () => Record<string, unknown> = rawMessage,
  notifications?: { send: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> },
) => {
  const channel = { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null };
  vi.mocked(collectChannels).mockResolvedValue({
    channels: [channel],
    liveChannelIds: new Set(['10']),
    gaps: [],
    complete: true,
    locations: [{ id: channel.id, name: channel.name, type: channel.type, passes: ['channels'] }],
  } as unknown as Awaited<ReturnType<typeof collectChannels>>);
  const client = {
    channels: { cache: new Map() },
    guilds: { fetch: async () => ({ id: '1' }) as Guild },
    rest: {
      get: vi.fn(async (route: string) =>
        route === '/channels/10/messages/100'
          ? { embeds: [], components: [] }
          : route.endsWith('/messages')
            ? [read()]
            : read(),
      ),
      ...(notifications === undefined ? {} : { patch: notifications.patch }),
    },
  } as unknown as Client;
  const worker = new ArchiveWorker({
    client,
    connections: manager,
    registry: {
      getRepos: () => undefined,
      getChannel: () =>
        notifications === undefined
          ? undefined
          : ({ id: '10', isSendable: () => true, send: notifications.send } as never),
      getRole: () => undefined,
      listGuildIds: () => ['1'],
    },
    config: archiveRuntimeSchema.parse({}),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    guildIds: ['1'],
    logger: createLogger({ level: 'silent', pretty: false }),
    translator: { t: (key: string) => key } as Translator,
  });
  return { worker, client };
};

describe('msg-archive worker integration', () => {
  it.each([false, true])(
    'preserves acknowledged manifest work during real history backfill and resumes interrupted coverage (interrupted=%s)',
    async (interrupted) =>
      withFreshConnection(async (connection) => {
        const manager = new StaticConnectionManager(connection);
        const first = fixture(manager);
        let resumed: ReturnType<typeof fixture> | undefined;
        try {
          const state = await first.worker.initialize('1');
          await connection.collection('fetches').insertOne({
            channelID: '10',
            channel: 'room',
            lastMessageID: '999',
          });
          const submit = async (command: ArchiveJob['command'], runId?: string) => {
            const jobId = `1:${command}`;
            await state.repo.submitJob({
              jobId,
              requestId: command,
              guildId: '1',
              command,
              options: {},
              ...(runId === undefined ? {} : { runId }),
              status: 'queued',
              cancelRequested: false,
              createdAt: Date.now(),
            });
            return jobId;
          };
          const planJobId = await submit('plan');
          await first.worker.pollJobs('1');
          const plan = await state.repo.getJob(planJobId);
          expect(plan).toMatchObject({ status: 'complete', result: { counts: { operations: 1 } } });
          const runId = plan!.runId!;
          expect(await connection.collection('messages').countDocuments()).toBe(0);

          const historyProgress: ArchiveProgressSnapshot[] = [];
          vi.mocked(first.client.rest.get).mockImplementation(async (route) => {
            historyProgress.push(state.progress!.snapshot());
            if (interrupted) throw new Error('temporary history failure');
            return route.endsWith('/messages') ? [rawMessage()] : rawMessage();
          });
          const applyJobId = await submit('apply', runId);
          await first.worker.pollJobs('1');
          const applied = await state.repo.getJob(applyJobId);
          expect(applied?.result?.['issues']).not.toContain('invalid-progress-total');
          if (!interrupted) expect(applied?.result?.['issues']).toEqual([]);
          expect(first.client.rest.get).toHaveBeenCalled();
          expect(historyProgress[0]?.phases.repair).toMatchObject({
            committed: 1,
            total: 1,
            unit: 'operations',
            quality: 'exact',
          });
          expect(historyProgress[0]?.phases.discovery.total).toBeUndefined();
          expect(historyProgress[0]?.phases.reactions.total).toBeUndefined();
          expect(applied).toMatchObject({
            status: interrupted ? 'partial' : 'complete',
            result: { progress: { phases: { repair: { committed: 1, total: 1 } } } },
          });
          expect(
            await connection.collection('archive_repair_operations').findOne({
              runId,
              reason: 'reset-cursor-for-full-reconciliation',
            }),
          ).toMatchObject({ state: 'verified' });
          if (interrupted) {
            expect(await connection.collection('messages').countDocuments()).toBe(0);
            await first.worker.stop();
            resumed = fixture(manager);
            const resumeJobId = await submit('resume', runId);
            await resumed.worker.pollJobs('1');
            expect(resumed.client.rest.get).toHaveBeenCalled();
            expect(await state.repo.getJob(resumeJobId)).toMatchObject({
              status: 'complete',
              runId,
              result: { issues: [], progress: { messages: { scanned: 1, durable: 1 } } },
            });
          }
          expect(
            await connection.collection('messages').findOne({ messageId: '101' }),
          ).toMatchObject({
            content: 'hello',
            schemaVersion: 2,
          });
          expect(
            await connection.collection('archive_repair_runs').findOne({ _id: runId as never }),
          ).toMatchObject({ status: 'complete', coverage: { status: 'complete' } });
        } finally {
          await first.worker.stop();
          await resumed?.worker.stop();
        }
      }),
  );

  it('drains periodic cancellation before admitting maintenance and resumes the same durable cutoff', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      let periodic: Promise<void> | undefined;
      let periodicEnded = false;
      try {
        const state = await worker.initialize('1');
        await connection.collection('messages').dropIndex('timestamp_1');
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        vi.mocked(client.rest.get).mockImplementationOnce(async (_route, options) => {
          enter();
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new Error('scan read cancelled'));
            if (options?.signal?.aborted) abort();
            else options?.signal?.addEventListener('abort', abort, { once: true });
          });
        });
        periodic = worker.periodic('1').then(() => {
          periodicEnded = true;
        });
        await entered;
        const interrupted = await connection.collection('archive_periodic_runs').findOne({});
        const originalClaim = state.repo.claimJob.bind(state.repo);
        vi.spyOn(state.repo, 'claimJob').mockImplementation(async (...args) => {
          expect(periodicEnded).toBe(true);
          expect(state.periodicWork).toBeUndefined();
          return originalClaim(...args);
        });
        await connection.collection('archive_jobs').insertOne({
          _id: '1:index-maintenance',
          jobId: '1:index-maintenance',
          requestId: 'index-maintenance',
          guildId: '1',
          command: 'migrate-timestamp',
          options: { mode: 'index' },
          status: 'queued',
          cancelRequested: false,
          createdAt: Date.now(),
        } as never);
        await worker.pollJobs('1');
        await periodic;
        expect(
          await connection.collection('archive_jobs').findOne({ jobId: '1:index-maintenance' }),
        ).toMatchObject({ status: 'complete' });
        expect(
          (await connection.collection('messages').indexes()).map((index) => index.name),
        ).toContain('timestamp_1');
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          runId: interrupted?.['runId'],
          cutoff: interrupted?.['cutoff'],
          status: 'partial',
        });
        await worker.periodic('1');
        const resumed = await connection.collection('archive_periodic_runs').findOne({});
        expect(resumed).toMatchObject({
          runId: interrupted?.['runId'],
          cutoff: interrupted?.['cutoff'],
          status: 'complete',
          progress: {
            messageCountQuality: 'lower-bound',
            messages: { scanned: 1, admitted: 1, durable: 1, inserted: 1 },
          },
        });
        const checkpoint = await connection
          .collection('archive_channels')
          .findOne({ channelId: '10' });
        expect(checkpoint).toMatchObject({
          checkpoint: {
            version: 2,
            statistics: {
              countQuality: 'lower-bound',
              messages: { scanned: 1, admitted: 1, durable: 1, inserted: 1 },
            },
          },
        });
      } finally {
        worker.cancel();
        await periodic;
        await worker.stop();
      }
    }));

  it('continues the saved daily notification reference across a real worker restart', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const notifications = {
        send: vi.fn(async () => ({ id: '100' })),
        patch: vi.fn(async () => ({})),
      };
      const first = fixture(manager, rawMessage, notifications);
      const get = vi.mocked(first.client.rest.get).getMockImplementation()!;
      let interruptedHistory = false;
      vi.mocked(first.client.rest.get).mockImplementation(async (route, options) => {
        if (route.endsWith('/messages') && !interruptedHistory) {
          interruptedHistory = true;
          throw new Error('temporary history failure');
        }
        return get(route, options);
      });
      await first.worker.periodic('1');
      const interrupted = await connection.collection('archive_periodic_runs').findOne({});
      await first.worker.stop();
      expect(interrupted?.['notification']).toMatchObject({ messageId: '100' });
      expect(notifications.send).toHaveBeenCalledTimes(1);
      const second = fixture(manager, rawMessage, notifications);
      try {
        await second.worker.periodic('1');
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          runId: interrupted?.['runId'],
          status: 'complete',
          notification: { messageId: '100', deliveredStatus: 'complete' },
        });
        expect(notifications.send).toHaveBeenCalledTimes(1);
        expect(notifications.patch).toHaveBeenCalled();
      } finally {
        await second.worker.stop();
      }
    }));

  it('keeps live capture and control jobs active while periodic scans default disabled', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.scheduledPeriodic('1', 60_000);
        expect(client.rest.get).not.toHaveBeenCalled();
        await worker.capture({
          eventId: 'disabled-delete',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'delete',
          observedAt: Date.now(),
        });
        await worker.pollJobs('1');
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        expect(
          await connection.collection('messages').findOne({ messageId: '101' }),
        ).toHaveProperty('deletion');
        await connection.collection('archive_jobs').insertOne({
          jobId: 'audit-disabled',
          requestId: 'audit-disabled',
          guildId: '1',
          command: 'audit',
          options: {},
          status: 'queued',
          cancelRequested: false,
          createdAt: Date.now(),
        });
        await worker.pollJobs('1');
        expect(
          await connection.collection('archive_jobs').findOne({ jobId: 'audit-disabled' }),
        ).toMatchObject({ status: 'complete' });
        await new ArchiveScheduleStore(connection, 60_000).update({ enabled: true });
        await worker.scheduledPeriodic('1', 60_000);
        expect(client.rest.get).toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }));

  it('keeps a due scan due when control work wins admission during its schedule claim', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const state = await worker.initialize('1');
      const store = new ArchiveScheduleStore(connection, 60_000);
      const scheduled = await store.update({ enabled: true });
      const start = ArchiveScheduleStore.prototype.start;
      const claim = vi
        .spyOn(ArchiveScheduleStore.prototype, 'start')
        .mockImplementation(async function (this: ArchiveScheduleStore) {
          const result = await start.call(this);
          state.working = 'job';
          return result;
        });
      try {
        await worker.scheduledPeriodic('1', 60_000);
        expect(client.rest.get).not.toHaveBeenCalled();
        expect(await store.read()).toMatchObject({
          nextRunAt: scheduled.nextRunAt,
          running: false,
        });
        claim.mockRestore();
        state.working = undefined;
        await worker.scheduledPeriodic('1', 60_000);
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          status: 'complete',
        });
      } finally {
        claim.mockRestore();
        state.working = undefined;
        await worker.stop();
      }
    }));

  it('pauses a periodic scan at its boundary without disabling future live writes', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.periodic('1', async () => false);
        expect(
          await connection
            .collection<{ _id: string; status: string }>('archive_periodic_runs')
            .findOne({ _id: 'current' }),
        ).toMatchObject({ status: 'partial', progress: { state: 'partial' } });
        const stopped = await worker.initialize('1');
        expect(stopped.heartbeat).toBeUndefined();
        expect(stopped.notifications).toBeUndefined();
        await worker.capture({
          eventId: 'paused-delete',
          guildId: '1',
          channelId: '10',
          messageId: '102',
          kind: 'delete',
          observedAt: Date.now(),
        });
        await worker.drainInbox('1');
        expect(
          await connection.collection('messages').findOne({ messageId: '102' }),
        ).toHaveProperty('deletion');
        await worker.periodic('1', async () => true);
        expect(
          await connection.collection('messages').findOne({ messageId: '101' }),
        ).toHaveProperty('content', 'hello');
      } finally {
        await worker.stop();
      }
    }));

  it('pauses within a reaction-heavy history page and resumes without advancing its checkpoint', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      let enabled = true;
      let reactionRequests = 0;
      const reactionCursors: (string | null)[] = [];
      vi.mocked(client.rest.get).mockImplementation(async (route, options) => {
        if (String(route).includes('/reactions/')) {
          reactionRequests += 1;
          reactionCursors.push(options?.query?.get('after') ?? null);
          enabled = false;
          return Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
        }
        return [
          {
            ...rawMessage(),
            reactions: [
              { emoji: { name: 'test' }, count: 101, count_details: { normal: 101, burst: 0 } },
            ],
          },
        ];
      });
      try {
        await worker.periodic('1', async () => enabled);
        // Normal and burst requests may already be admitted, but neither may fetch another page.
        expect(reactionRequests).toBeGreaterThan(0);
        expect(reactionRequests).toBeLessThanOrEqual(2);
        expect(reactionCursors.every((cursor) => cursor === null)).toBe(true);
        const run = await connection.collection('archive_periodic_runs').findOne({});
        expect(run).toMatchObject({ status: 'partial' });
        const state = await worker.initialize('1');
        expect(state.generations.size).toBe(0);
        expect((await state.repo.listChannels())[0]?.checkpoint).toMatchObject({
          complete: false,
          scanned: 0,
        });
        vi.mocked(client.rest.get).mockResolvedValue([rawMessage()]);
        enabled = true;
        await worker.periodic('1', async () => enabled);
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          runId: run!['runId'],
          cutoff: run!['cutoff'],
          status: 'complete',
        });
      } finally {
        await worker.stop();
      }
    }));

  it('backs up without a debug channel and records durable cutoff checkpoints', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker } = fixture(manager);
      try {
        await worker.periodic('1');
        const stored = await connection.collection('messages').findOne({ messageId: '101' });
        expect(stored?.content).toBe('hello');
        expect(stored?.schemaVersion).toBe(2);
        const channel = await connection
          .collection('archive_channels')
          .findOne({ channelId: '10' });
        expect(channel?.checkpoint.complete).toBe(true);
        expect(channel?.checkpoint.cutoff).toBeTypeOf('number');
      } finally {
        await worker.stop();
      }
    }));
  it('persists uncached deletes and cannot resurrect them from a later history observation', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker } = fixture(manager);
      try {
        await worker.capture({
          eventId: 'delete:1',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'delete',
          observedAt: Date.now(),
        });
        await worker.drainInbox('1');
        await worker.periodic('1');
        const stored = await connection.collection('messages').findOne({ messageId: '101' });
        expect(stored?.deletion).toBeDefined();
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('defaults both automated source lists to empty', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker } = fixture(manager, () => ({
        ...rawMessage(),
        author: { id: '1000', username: 'bot', bot: true },
      }));
      try {
        await worker.periodic('1');
        expect(await connection.collection('messages').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('resumes a partial periodic cutoff across worker restarts and then revisits downtime changes', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      vi.mocked(first.client.rest.get).mockRejectedValueOnce(
        new Error('temporary history failure'),
      );
      await first.worker.periodic('1');
      const interrupted = await connection.collection('archive_periodic_runs').findOne({});
      expect(interrupted?.status).toBe('partial');
      await first.worker.stop();
      const second = fixture(manager);
      try {
        await second.worker.periodic('1');
        const resumed = await connection.collection('archive_periodic_runs').findOne({});
        expect(resumed?.runId).toBe(interrupted?.runId);
        expect(resumed?.cutoff).toBe(interrupted?.cutoff);
        expect(resumed?.status).toBe('complete');
        await second.worker.periodic('1');
        const fresh = await connection.collection('archive_periodic_runs').findOne({});
        expect(fresh?.runId).not.toBe(resumed?.runId);
        expect(fresh?.full).toBe(true);
      } finally {
        await second.worker.stop();
      }
    }));
  it('classifies an existing excluded source without replacing its content or deleting it', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker } = fixture(manager, () => ({
        ...rawMessage(),
        content: 'excluded current body',
        author: { id: '1000', username: 'bot', bot: true },
      }));
      try {
        await worker.initialize('1');
        await connection
          .collection('messages')
          .insertOne({ messageId: '101', channelId: '10', content: 'legacy evidence' });
        await worker.periodic('1');
        const stored = await connection.collection('messages').findOne({ messageId: '101' });
        expect(stored?.authorKind).toBe('bot');
        expect(stored?.content).toBe('legacy evidence');
        expect(await connection.collection('archive_revisions').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('keeps failed live reconciliation pending without blocking later deletes', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker, client } = fixture(manager);
      vi.mocked(client.rest.get).mockRejectedValue(new Error('temporary REST failure'));
      try {
        await worker.capture({
          eventId: 'snapshot:1',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'snapshot',
          observedAt: 100,
          raw: rawMessage(),
        });
        await worker.capture({
          eventId: 'delete:2',
          guildId: '1',
          channelId: '10',
          messageId: '102',
          kind: 'delete',
          observedAt: 200,
        });
        await worker.drainInbox('1');
        expect(
          (await connection.collection('messages').findOne({ messageId: '101' }))?.content,
        ).toBe('hello');
        expect(
          (await connection.collection('messages').findOne({ messageId: '102' }))?.deletion,
        ).toBeDefined();
        const pending = await connection
          .collection('archive_inbox')
          .findOne({ eventId: 'snapshot:1' });
        expect(pending?.state).toBe('pending');
        expect(pending?.nextAttemptAt).toBeGreaterThan(Date.now());
      } finally {
        await worker.stop();
      }
    }));

  it('preserves A-B-A Gateway versions when REST already returns the newest body', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      let current = 'A';
      const { worker } = fixture(manager, () => ({
        ...rawMessage(),
        content: current,
        edited_timestamp: null,
      }));
      const base = Date.now() - 1000;
      try {
        for (const [index, content] of ['A', 'B', 'A'].entries()) {
          await worker.capture({
            eventId: `version:${index}`,
            guildId: '1',
            channelId: '10',
            messageId: '101',
            kind: 'snapshot',
            observedAt: base + index,
            raw: { ...rawMessage(), content, edited_timestamp: null },
          });
        }
        await worker.drainInbox('1');
        current = 'C';
        await worker.capture({
          eventId: 'version:3',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'snapshot',
          observedAt: Date.now(),
          raw: { ...rawMessage(), content: current, edited_timestamp: null },
        });
        await worker.drainInbox('1');
        const revisions = await connection
          .collection('archive_revisions')
          .find({ messageId: '101' })
          .toArray();
        expect(
          revisions
            .filter((revision) => revision.snapshot.content === 'A')
            .map((revision) => revision.versionObservationId),
        ).toEqual(expect.arrayContaining(['version:0', 'version:2']));
        expect(revisions.some((revision) => revision.snapshot.content === 'B')).toBe(true);
        expect(
          (await connection.collection('messages').findOne({ messageId: '101' }))?.content,
        ).toBe('C');
      } finally {
        await worker.stop();
      }
    }));

  it('keeps only source evidence in the inbox for an empty bot allowlist', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { worker } = fixture(manager);
      try {
        await worker.capture({
          eventId: 'excluded:1',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'snapshot',
          observedAt: Date.now(),
          raw: {
            ...rawMessage(),
            author: { id: '1000', username: 'bot', bot: true },
            content: 'excluded body',
            embeds: [{ description: 'excluded embed' }],
          },
        });
        const pending = await connection
          .collection('archive_inbox')
          .findOne({ eventId: 'excluded:1' });
        expect(pending?.payload.authorKind).toBe('bot');
        expect(pending?.payload.content).toBeUndefined();
        expect(pending?.payload.embeds).toBeUndefined();
        await worker.drainInbox('1');
        expect(await connection.collection('messages').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
});
