import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
} from '../../../src/persistence/repositories/archive-repos';
import { archiveBackupNotifiers } from '../../../src/plugins/message-backup/runtime/backup-notifier';
import { ChannelType, type Client, type Guild } from 'discord.js';
import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type {
  ArchiveFullBackupJob,
  ArchiveGatewayContinuity,
  ArchiveJob,
  ArchivePeriodicRecord,
} from '../../../src/core/archive/types';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import { ArchiveCapacityError } from '../../../src/core/archive/errors';
import { createLogger } from '../../../src/core/logger';
import type { Translator } from '../../../src/core/i18n';
import { unwrap } from '../../../src/core/result';
import { archiveControlFor } from '../../helpers/archive-control';
import { MongoArchiveScheduleRepo } from '../../../src/persistence/repositories/archive-schedule.repo';
import type * as StorageModule from '../../../src/infra/archive/storage-usage';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { withFreshConnection } from '../helpers/mongo';

/** A raw `messages` document, keyed by the Discord message ID. */
type StoredMessage = { _id: string } & Record<string, any>;

vi.mock('../../../src/plugins/message-backup/internal/collect-channels', () => ({
  collectChannels: vi.fn(),
}));
vi.mock('../../../src/infra/archive/storage-usage', async (original) => {
  const actual = await original<typeof StorageModule>();
  return {
    ...actual,
    ArchiveStorageSampler: class {
      public async sample() {
        return {
          usedBytes: 0,
          availableBytes: 200_000_000_000,
          measuredAt: Date.now(),
          roots: ['/test'],
        };
      }
    },
  };
});

const actor = { userId: '11', channelId: '22', messageId: '33' };
const message = (id: string, reactions: unknown[] = []) => ({
  id,
  guild_id: '1',
  channel_id: '10',
  author: { id: '1000', username: 'human', bot: false },
  content: `message ${id}`,
  timestamp: '2020-01-01T00:00:00Z',
  attachments: [],
  embeds: [],
  reactions,
});
/** One full page of 100 messages: ids 1100 down to 1001. */
const fullPage = () => Array.from({ length: 100 }, (_, index) => message(String(1100 - index)));

const inventory = (hidden = false) => {
  const channel = { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null };
  vi.mocked(collectChannels).mockResolvedValue({
    channels: [channel],
    liveChannelIds: new Set(hidden ? ['10', '20'] : ['10']),
    gaps: hidden ? [{ pass: 'history', channelId: '20', reason: 'missing-view-channel' }] : [],
    complete: true,
    locations: [
      { id: '10', name: 'room', type: ChannelType.GuildText, passes: ['channels'] },
      ...(hidden
        ? [{ id: '20', name: 'hidden', type: ChannelType.GuildText, passes: ['channels'] }]
        : []),
    ],
  } as unknown as Awaited<ReturnType<typeof collectChannels>>);
};

const fixture = (
  manager: StaticConnectionManager,
  extra: Partial<ConstructorParameters<typeof ArchiveWorker>[0]> = {},
) => {
  const get = vi.fn(
    async (route: string): Promise<unknown> =>
      route.endsWith('/messages') ? [message('101')] : message('101'),
  );
  const patch = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({ id: '90' }));
  const client = {
    channels: { cache: new Map() },
    guilds: {
      fetch: async () => ({ id: '1', channels: { cache: new Map() } }) as unknown as Guild,
    },
    rest: { get, patch },
  } as unknown as Client;
  const logger = createLogger({ level: 'silent', pretty: false });
  // Nested parameters show which keys a panel rendered.
  const translator = {
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}${JSON.stringify(params)}`,
  } as Translator;
  const worker = new ArchiveWorker({
    client,
    // Tests drain the inbox explicitly; the loop has its own tests.
    inboxLoop: false,
    connections: manager,
    registry: {
      getRepos: () => undefined,
      getChannel: () => ({ id: '22', isSendable: () => true, send }) as never,
      getRole: () => undefined,
      listGuildIds: () => ['1'],
    },
    config: archiveRuntimeSchema.parse({}),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    guildIds: ['1'],
    logger,
    translator,
    backupNotifiers: archiveBackupNotifiers(client, translator),
    archiveRepos: buildArchiveRepos,
    writerRepos: buildArchiveWriterRepos,
    ...extra,
  });
  return { worker, get, patch, send, logger, client };
};

/** Confirms a full backup the way the `/archive backup` panel does. */
const confirmBackup = async (connection: Connection): Promise<ArchiveFullBackupJob> => {
  const control = await archiveControlFor(connection);
  const { token } = await control.requestConfirmation(actor);
  return unwrap(await control.confirm(token, actor));
};
const jobOf = (connection: Connection, jobId: string) =>
  connection.collection<ArchiveFullBackupJob>('archive_jobs').findOne({ jobId });
const fullCheckpoint = async (connection: Connection) =>
  (
    (await connection.collection('archive_channels').findOne({ channelId: '10' }))?.[
      'checkpoints'
    ] as Record<string, Record<string, unknown>> | undefined
  )?.['full-backup'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('msg-archive full backup', () => {
  it('runs a confirmed backup to completion as its own full run and shows the result', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const manager = new StaticConnectionManager(connection);
      const { worker, patch } = fixture(manager);
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const done = await jobOf(connection, job.jobId);
        // Rebuild tools find the newest complete full backup and read its cutoff.
        expect(done).toMatchObject({
          command: 'full-backup',
          status: 'complete',
          finishedAt: expect.any(Number),
          result: {
            cutoff: job.options['cutoff'],
            gaps: [],
            counts: { scanned: 1, written: 1, staleReactions: 0 },
            progress: { work: 'full-backup', messages: { scanned: 1, inserted: 1 } },
          },
          notification: { messageId: '33', deliveredStatus: 'complete' },
        });
        expect(done?.activeSlot).toBeUndefined();
        expect(await fullCheckpoint(connection)).toMatchObject({
          runId: job.runId,
          complete: true,
        });
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(1);
        expect(patch).toHaveBeenCalledWith('/channels/22/messages/33', expect.anything());
        const last = JSON.stringify(patch.mock.calls.at(-1));
        expect(last).toContain('replies:archive.backup_state_complete');
        // The first start's continuity settles the full requirement of a fresh guild.
        const continuity = await connection
          .collection<ArchiveGatewayContinuity & { _id: string }>('archive_gateway_continuity')
          .findOne({ _id: 'current' });
        expect(continuity?.fullRequired).toBe(false);
      } finally {
        await worker.stop();
      }
    }));

  it('rereads every reaction list, even ones a periodic pass may keep', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      const reacted = message('101', [
        { emoji: { id: null, name: 'x' }, count: 1, count_details: { normal: 1, burst: 0 } },
      ]);
      get.mockImplementation(async (route: string) =>
        route.endsWith('/messages')
          ? [reacted]
          : route.includes('/reactions/')
            ? [{ id: '7' }]
            : reacted,
      );
      const reactionReads = () => get.mock.calls.filter(([route]) => route.includes('/reactions/'));
      try {
        await worker.initialize('1');
        await worker.periodic('1');
        get.mockClear();
        // An incremental periodic pass keeps the unchanged list.
        await worker.periodic('1');
        expect(reactionReads()).toHaveLength(0);
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect((await jobOf(connection, job.jobId))?.status).toBe('complete');
        expect(reactionReads()).toHaveLength(1);
      } finally {
        await worker.stop();
      }
    }));

  it('completes with only known coverage gaps', async () =>
    withFreshConnection(async (connection) => {
      inventory(true);
      const { worker, patch } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const done = await jobOf(connection, job.jobId);
        expect(done).toMatchObject({ status: 'complete', result: { issues: [] } });
        expect(done?.result?.['gaps']).toEqual(['20: missing-view-channel']);
        expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
          'replies:archive.backup_state_gaps',
        );
      } finally {
        await worker.stop();
      }
    }));

  it('scans the source with the most stored work first', async () =>
    withFreshConnection(async (connection) => {
      const rooms = ['10', '20', '30'].map((id) => ({
        id,
        name: `room-${id}`,
        type: ChannelType.GuildText,
        parentId: null,
      }));
      vi.mocked(collectChannels).mockResolvedValue({
        channels: rooms,
        liveChannelIds: new Set(rooms.map(({ id }) => id)),
        gaps: [],
        complete: true,
        locations: rooms.map(({ id, name }) => ({ id, name, type: ChannelType.GuildText })),
      } as unknown as Awaited<ReturnType<typeof collectChannels>>);
      // Discovery order is 10, 20, 30; the archive holds most for 30, then 20.
      const stored = (id: number, channelId: string, reactions = 0) => ({
        _id: String(id),
        schemaVersion: 3,
        channelId,
        createdTimestamp: Date.parse('2020-01-01T00:00:00Z') + id,
        observedAt: 1,
        ...(reactions === 0 ? {} : { reactions: [{ emoji: { name: 'x' }, count: reactions }] }),
      });
      await connection
        .collection<StoredMessage>('messages')
        .insertMany([
          stored(1, '20'),
          stored(2, '20'),
          stored(3, '30', 1),
          stored(4, '30', 1),
          stored(5, '30', 1),
        ]);
      const { worker, get } = fixture(new StaticConnectionManager(connection), {
        config: archiveRuntimeSchema.parse({ concurrency: 1 }),
      });
      get.mockImplementation(async () => []);
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect((await jobOf(connection, job.jobId))?.status).toBe('complete');
        const history = (get.mock.calls as unknown as [string][])
          .map(([route]) => route)
          .filter((route) => /^\/channels\/\d+\/messages$/.test(route));
        expect(history).toEqual([
          '/channels/30/messages',
          '/channels/20/messages',
          '/channels/10/messages',
        ]);
      } finally {
        await worker.stop();
      }
    }));

  it('stops cooperatively and resumes with the same cutoff and checkpoints', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      const control = await archiveControlFor(connection);
      const befores: string[] = [];
      get.mockImplementation(async (route: string, options?: { query?: URLSearchParams }) => {
        if (!route.endsWith('/messages')) return message('101');
        const before = options?.query?.get('before') ?? '';
        befores.push(before);
        return befores.length === 1 ? fullPage() : [];
      });
      try {
        const state = await worker.initialize('1');
        const job = await confirmBackup(connection);
        const upsert = state.repos.channels.upsertChannel.bind(state.repos.channels);
        vi.spyOn(state.repos.channels, 'upsertChannel').mockImplementation(
          async (channel, context) => {
            await upsert(channel, context);
            const saved = channel.checkpoints?.['full-backup'] as { pageSequence?: number };
            if (saved?.pageSequence === 1) {
              unwrap(await control.stop(job.jobId));
              // Past the stop-check cache, so the next boundary observes the request.
              await sleep(300);
            }
          },
        );
        await worker.pollJobs('1');
        const stopped = await jobOf(connection, job.jobId);
        expect(stopped).toMatchObject({ status: 'cancelled', cancelRequested: true });
        expect(stopped?.activeSlot).toBeUndefined();
        const checkpoint = await fullCheckpoint(connection);
        expect(checkpoint).toMatchObject({ runId: job.runId, pageSequence: 1, complete: false });
        vi.mocked(state.repos.channels.upsertChannel).mockRestore();
        unwrap(await control.resume(job.jobId, { channelId: '22', messageId: '33' }));
        await worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          status: 'complete',
          options: { cutoff: job.options['cutoff'] },
          result: { cutoff: job.options['cutoff'] },
        });
        // The resumed scan continued after the saved page instead of starting over.
        expect(befores.at(-1)).toBe('1001');
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(100);
      } finally {
        await worker.stop();
      }
    }));

  it('continues after a restart with the same cutoff and checkpoints', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      let pages = 0;
      first.get.mockImplementation(async (route: string) => {
        if (!route.endsWith('/messages')) return message('101');
        pages += 1;
        return pages === 1 ? fullPage() : [];
      });
      const state = await first.worker.initialize('1');
      const job = await confirmBackup(connection);
      const upsert = state.repos.channels.upsertChannel.bind(state.repos.channels);
      vi.spyOn(state.repos.channels, 'upsertChannel').mockImplementation(
        async (channel, context) => {
          await upsert(channel, context);
          const saved = channel.checkpoints?.['full-backup'] as { pageSequence?: number };
          if (saved?.pageSequence === 1) first.worker.cancel();
        },
      );
      await first.worker.pollJobs('1');
      await first.worker.stop();
      // Shutdown is not the job's outcome: it is still running until the next boot.
      expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'running' });
      const second = fixture(manager);
      const befores: string[] = [];
      second.get.mockImplementation(
        async (route: string, options?: { query?: URLSearchParams }) => {
          if (!route.endsWith('/messages')) return message('101');
          befores.push(options?.query?.get('before') ?? '');
          return [];
        },
      );
      try {
        await second.worker.initialize('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'queued' });
        await second.worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          status: 'complete',
          result: { cutoff: job.options['cutoff'] },
        });
        expect(befores).toEqual(['1001']);
      } finally {
        await second.worker.stop();
      }
    }));

  it('pauses periodic backup while a full backup runs', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      get.mockImplementation(async (route: string) => {
        if (route.endsWith('/messages')) {
          entered();
          await blocked;
          return [message('101')];
        }
        return message('101');
      });
      try {
        await worker.initialize('1');
        const schedule = new MongoArchiveScheduleRepo(connection, 60_000);
        const enabled = await schedule.update({ enabled: true });
        const job = await confirmBackup(connection);
        const backup = worker.pollJobs('1');
        await started;
        await worker.scheduledPeriodic('1', 60_000);
        expect(await connection.collection('archive_periodic_runs').countDocuments()).toBe(0);
        expect(await schedule.read()).toMatchObject({
          nextRunAt: enabled.nextRunAt,
          running: false,
        });
        release();
        await backup;
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'complete' });
        await worker.scheduledPeriodic('1', 60_000);
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          status: 'complete',
        });
      } finally {
        release();
        await worker.stop();
      }
    }));

  it('checkpoints a page whose message reactions keep changing and counts it incomplete', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      const reacted = message('101', [
        { emoji: { name: 'x' }, count: 1, count_details: { normal: 1, burst: 0 } },
      ]);
      try {
        const state = await worker.initialize('1');
        get.mockImplementation(async (route: string): Promise<unknown> => {
          if (route.includes('/reactions/')) {
            // Every membership read races a live change of the same message.
            state.dirty.observe('101');
            return [{ id: '5' }];
          }
          return route.endsWith('/messages') ? [reacted] : reacted;
        });
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          status: 'complete',
          result: { counts: { staleReactions: 1 }, progress: { reactions: { stale: 1 } } },
        });
        expect(await fullCheckpoint(connection)).toMatchObject({ complete: true });
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(stored?.['reactionsStaleAt']).toBeTypeOf('number');
      } finally {
        await worker.stop();
      }
    }));

  it('keeps the full requirement when a Gateway gap occurs during the backup', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.initialize('1');
        get.mockImplementation(async (route: string) => {
          if (route.endsWith('/messages')) {
            await worker.markGap('gateway-disconnect');
            return [message('101')];
          }
          return message('101');
        });
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        // The scan saw the gap, so it is blocked rather than complete.
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'partial' });
        const continuity = await connection
          .collection<ArchiveGatewayContinuity & { _id: string }>('archive_gateway_continuity')
          .findOne({ _id: 'current' });
        expect(continuity?.fullRequired).toBe(true);
      } finally {
        await worker.stop();
      }
    }));

  it('retries a failed final write before releasing the backup', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        const state = await worker.initialize('1');
        const update = state.repos.jobs.updateJob.bind(state.repos.jobs);
        let failures = 0;
        vi.spyOn(state.repos.jobs, 'updateJob').mockImplementation(
          async (jobId, patch, ...rest) => {
            if (patch.status === 'complete' && failures === 0) {
              failures += 1;
              throw new Error('temporary database outage');
            }
            return update(jobId, patch, ...rest);
          },
        );
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect(failures).toBe(1);
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'complete' });
      } finally {
        await worker.stop();
      }
    }));

  it('leaves a gap-details page alone and records the result for later', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, patch } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await (
          await archiveControlFor(connection)
        ).setPanel(job.jobId, {
          channelId: '22',
          messageId: '33',
          view: 'gaps',
        });
        await worker.pollJobs('1');
        expect(patch).not.toHaveBeenCalled();
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          status: 'complete',
          notification: { view: 'gaps', deliveredStatus: 'complete' },
        });
      } finally {
        await worker.stop();
      }
    }));

  it('stops updating a deleted panel instead of posting a new one', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, patch, send } = fixture(new StaticConnectionManager(connection));
      patch.mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 }));
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const done = await jobOf(connection, job.jobId);
        expect(done).toMatchObject({ status: 'complete', notification: { channelId: '22' } });
        expect(done?.notification?.messageId).toBeUndefined();
        expect(send).not.toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }));

  it('keeps ten finished records and never prunes running or resumable backups', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        const state = await worker.initialize('1');
        const conn = state.conn;
        const periodic = (index: number): ArchivePeriodicRecord => ({
          jobId: `1:record-${index}`,
          requestId: `record-${index}`,
          guildId: '1',
          command: 'periodic',
          options: { cutoff: index, full: false },
          status: 'complete',
          result: { cutoff: index, issueCount: 0 },
          cancelRequested: false,
          createdAt: index,
          finishedAt: index,
        });
        const backup = (
          index: number,
          extra: Partial<ArchiveFullBackupJob> = {},
        ): ArchiveFullBackupJob => ({
          jobId: `1:record-${index}`,
          requestId: `record-${index}`,
          guildId: '1',
          command: 'full-backup',
          options: { cutoff: index },
          status: 'complete',
          cancelRequested: false,
          createdAt: index,
          finishedAt: index,
          ...extra,
        });
        await connection.collection<ArchiveJob & { _id: string }>('archive_jobs').insertMany(
          [
            backup(0),
            ...Array.from({ length: 14 }, (_, index) => periodic(index + 1)),
            backup(20, { status: 'running', finishedAt: undefined }),
            // The newest full backup is stopped: it can still resume.
            backup(21, { status: 'cancelled', finishedAt: 0.5 }),
          ].map((job) => ({ ...job, _id: job.jobId })),
        );
        expect(await state.repos.jobs.pruneJobRecords(10)).toBe(4);
        const left = await conn.models.ArchiveJob.find({}, { jobId: 1 }).lean().exec();
        expect(left.map((job) => job.jobId).sort()).toEqual(
          [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 21].map((index) => `1:record-${index}`).sort(),
        );
      } finally {
        await worker.stop();
      }
    }));

  it('ends failed with a reason, releases the slot, and resumes to completion with the same cutoff', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const control = await archiveControlFor(connection);
      const fetchGuild = vi
        .spyOn(client.guilds, 'fetch')
        .mockRejectedValueOnce(new Error('Missing Access to guild'));
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const failed = await jobOf(connection, job.jobId);
        expect(failed).toMatchObject({
          status: 'failed',
          result: { status: 'failed', reason: 'permission', cutoff: job.options.cutoff },
        });
        expect(failed?.activeSlot).toBeUndefined();
        expect(fetchGuild).toHaveBeenCalled();
        unwrap(await control.resume(job.jobId, { channelId: '22', messageId: '33' }));
        await worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          status: 'complete',
          options: { cutoff: job.options.cutoff },
          result: { cutoff: job.options.cutoff },
        });
      } finally {
        await worker.stop();
      }
    }));

  it('fails a job without a fixed cutoff instead of scanning', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.initialize('1');
        await connection.collection('archive_jobs').insertOne({
          _id: '1:broken',
          jobId: '1:broken',
          requestId: 'broken',
          guildId: '1',
          command: 'full-backup',
          options: {},
          runId: 'full:broken',
          status: 'queued',
          cancelRequested: false,
          activeSlot: 'full-backup',
          createdAt: Date.now(),
        } as never);
        await worker.pollJobs('1');
        const failed = await jobOf(connection, '1:broken');
        expect(failed).toMatchObject({ status: 'failed' });
        expect(failed?.activeSlot).toBeUndefined();
        expect(get).not.toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }));

  it('ends a storage pause as partial with the capacity reason, never stopped', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        const state = await worker.initialize('1');
        const reserve = state.storage.withReservation.bind(state.storage);
        vi.spyOn(state.storage, 'withReservation').mockImplementation(
          async (bytes, background, operation) => {
            if (background)
              throw new ArchiveCapacityError('Archive backfill paused: storage headroom exhausted');
            return reserve(bytes, background, operation);
          },
        );
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const paused = await jobOf(connection, job.jobId);
        expect(paused).toMatchObject({
          status: 'partial',
          cancelRequested: false,
          result: { reason: 'capacity' },
        });
        expect(paused?.activeSlot).toBeUndefined();
      } finally {
        await worker.stop();
      }
    }));

  it('fails the page on a systemic reaction failure instead of marking messages stale', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      const reacted = message('101', [
        { emoji: { name: 'x' }, count: 1, count_details: { normal: 1, burst: 0 } },
      ]);
      get.mockImplementation(async (route: string) => {
        if (route.includes('/reactions/'))
          throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        return route.endsWith('/messages') ? [reacted] : reacted;
      });
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'partial' });
        expect(await fullCheckpoint(connection)).toMatchObject({ complete: false });
      } finally {
        await worker.stop();
      }
    }));

  it('ends a claimed backup partial while the guild is in capture-only mode', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get } = fixture(new StaticConnectionManager(connection));
      try {
        const state = await worker.initialize('1');
        state.ready = false;
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const ended = await jobOf(connection, job.jobId);
        expect(ended).toMatchObject({
          status: 'partial',
          result: { issues: ['structural-maintenance-required'] },
        });
        expect(ended?.activeSlot).toBeUndefined();
        expect(get).not.toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }));

  it('ends a backup stopped before a restart without scanning it', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const manager = new StaticConnectionManager(connection);
      await connection.collection('archive_jobs').insertOne({
        _id: '1:stopping',
        jobId: '1:stopping',
        requestId: 'stopping',
        guildId: '1',
        command: 'full-backup',
        options: { cutoff: Date.now() },
        runId: 'full:stopping',
        status: 'running',
        cancelRequested: true,
        activeSlot: 'full-backup',
        createdAt: Date.now(),
      } as never);
      const { worker, get } = fixture(manager);
      try {
        await worker.initialize('1');
        const stopped = await jobOf(connection, '1:stopping');
        expect(stopped).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Number) });
        expect(stopped?.activeSlot).toBeUndefined();
        await worker.pollJobs('1');
        expect(get).not.toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }));

  it('keeps an unsaved result after five attempts and saves it on a later poll', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const manager = new StaticConnectionManager(connection);
      const { worker, logger, patch } = fixture(manager, { terminalRetryBaseMs: 1 });
      const errors = vi.spyOn(logger, 'error');
      try {
        const state = await worker.initialize('1');
        const update = state.repos.jobs.updateJob.bind(state.repos.jobs);
        let outage = true;
        const terminalWrites = vi
          .spyOn(state.repos.jobs, 'updateJob')
          .mockImplementation(async (jobId, change, ...rest) => {
            if (change.status !== undefined && outage) throw new Error('temporary database outage');
            return update(jobId, change, ...rest);
          });
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        expect(terminalWrites.mock.calls.filter(([, change]) => change.status).length).toBe(5);
        expect(
          errors.mock.calls.filter(
            (call) => (call as unknown[])[1] === 'Archive job result could not be saved',
          ),
        ).toHaveLength(1);
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'running' });
        // Periodic passes stay paused while the result is unsaved.
        await new MongoArchiveScheduleRepo(connection, 60_000).update({ enabled: true });
        await worker.scheduledPeriodic('1', 60_000);
        expect(await connection.collection('archive_periodic_runs').countDocuments()).toBe(0);
        outage = false;
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
        patch.mockClear();
        await worker.pollJobs('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'complete' });
        expect(JSON.stringify(patch.mock.calls.at(-1))).toContain('backup_state_complete');
      } finally {
        vi.restoreAllMocks();
        await worker.stop();
      }
    }));

  it('queues an exhausted unsaved backup again on the next start', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager, { terminalRetryBaseMs: 1 });
      const state = await first.worker.initialize('1');
      vi.spyOn(state.repos.jobs, 'updateJob').mockRejectedValue(new Error('database outage'));
      const job = await confirmBackup(connection);
      await first.worker.pollJobs('1');
      await first.worker.stop();
      const second = fixture(manager);
      try {
        await second.worker.initialize('1');
        expect(await jobOf(connection, job.jobId)).toMatchObject({ status: 'queued' });
      } finally {
        await second.worker.stop();
      }
    }));

  it('retries a failed result edit with backoff on later polls', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, patch } = fixture(new StaticConnectionManager(connection));
      patch.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        await worker.pollJobs('1');
        const deferred = await jobOf(connection, job.jobId);
        expect(deferred).toMatchObject({
          status: 'complete',
          notification: { attempts: 1, retryAt: expect.any(Number) },
        });
        expect(deferred?.notification?.deliveredStatus).toBeUndefined();
        patch.mockClear();
        patch.mockResolvedValue({});
        // Not yet due: nothing is edited.
        await worker.pollJobs('1');
        expect(patch).not.toHaveBeenCalled();
        await connection
          .collection('archive_jobs')
          .updateOne({ jobId: job.jobId }, { $set: { 'notification.retryAt': 0 } });
        await worker.pollJobs('1');
        expect(patch).toHaveBeenCalledWith('/channels/22/messages/33', expect.anything());
        expect(await jobOf(connection, job.jobId)).toMatchObject({
          notification: { deliveredStatus: 'complete' },
        });
      } finally {
        await worker.stop();
      }
    }));

  it('prunes old records when a backup or a periodic pass ends', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker } = fixture(new StaticConnectionManager(connection));
      const old = (index: number) => ({
        _id: `1:old-${index}`,
        jobId: `1:old-${index}`,
        requestId: `old-${index}`,
        guildId: '1',
        command: 'periodic',
        options: { cutoff: index, full: false },
        status: 'complete',
        result: { cutoff: index, issueCount: 0 },
        cancelRequested: false,
        createdAt: index,
        startedAt: index,
        finishedAt: index,
      });
      try {
        await worker.initialize('1');
        await connection
          .collection('archive_jobs')
          .insertMany(Array.from({ length: 12 }, (_, index) => old(index + 1)) as never[]);
        await confirmBackup(connection);
        await worker.pollJobs('1');
        expect(await connection.collection('archive_jobs').countDocuments()).toBe(10);
        await connection
          .collection('archive_jobs')
          .insertMany(Array.from({ length: 5 }, (_, index) => old(index + 100)) as never[]);
        await worker.periodic('1');
        expect(await connection.collection('archive_jobs').countDocuments()).toBe(10);
        expect(
          await connection.collection('archive_jobs').countDocuments({ command: 'full-backup' }),
        ).toBe(1);
      } finally {
        await worker.stop();
      }
    }));

  it('refreshes the panel and renews the lease on the ten-second heartbeat', async () =>
    withFreshConnection(async (connection) => {
      inventory();
      const { worker, get, patch } = fixture(new StaticConnectionManager(connection));
      const heartbeats: (() => void)[] = [];
      const schedule = globalThis.setInterval;
      const intervals = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
        callback: () => void,
        ms?: number,
      ) => {
        if (ms === 10_000) heartbeats.push(callback);
        return schedule(callback, ms);
      }) as typeof setInterval);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      get.mockImplementation(async (route: string) => {
        if (route.endsWith('/messages')) {
          entered();
          await blocked;
          return [message('101')];
        }
        return message('101');
      });
      const clock = vi.spyOn(Date, 'now');
      try {
        await worker.initialize('1');
        const job = await confirmBackup(connection);
        const running = worker.pollJobs('1');
        await started;
        await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(0));
        const before = await jobOf(connection, job.jobId);
        const edits = patch.mock.calls.length;
        const later = Date.now() + 11_000;
        clock.mockImplementation(() => later);
        for (const beat of heartbeats) beat();
        await vi.waitFor(async () => {
          expect(patch.mock.calls.length).toBeGreaterThan(edits);
          const after = await jobOf(connection, job.jobId);
          expect(after?.leaseUntil).toBe(later + 60_000);
          expect(after?.leaseUntil).toBeGreaterThan(before?.leaseUntil ?? 0);
          expect(after?.result?.progress?.state).toBe('running');
        });
        expect(JSON.stringify(patch.mock.calls.at(-1))).toContain('backup_state_running');
        clock.mockRestore();
        release();
        await running;
      } finally {
        intervals.mockRestore();
        clock.mockRestore();
        release();
        await worker.stop();
      }
    }));
});
