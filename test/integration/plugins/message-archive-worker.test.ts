import {
  archiveBackupNotifiers,
  type ArchivePanelDelivery,
} from '../../../src/plugins/message-backup/runtime/backup-notifier';
import { ARCHIVE_PERIODIC_RETRY_DELAY_MS } from '../../../src/core/archive/schedule';
import { MongoArchiveScheduleRepo } from '../../../src/persistence/repositories/archive-schedule.repo';
import type * as StorageModule from '../../../src/infra/archive/storage-usage';
import { type Client, type Guild, ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  StaticConnectionManager,
  type ConnectionManager,
} from '../../../src/infra/mongo/connection-manager';
import { asGuildId } from '../../../src/core/ids';
import { ArchiveGatewayDecoder } from '../../../src/plugins/message-backup/runtime/gateway-event';
import type { ArchiveGatewayReadiness } from '../../../src/plugins/message-backup/runtime/gateway-readiness';
import { archiveControlFor } from '../../helpers/archive-control';
import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
} from '../../../src/persistence/repositories/archive-repos';
import { ARCHIVE_LIMITS } from '../../../src/core/archive/limits';
import {
  ArchiveCapacityError,
  ArchiveContinuityConflictError,
} from '../../../src/core/archive/errors';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import {
  ArchivePolicySchema,
  INTERACTION_RECORD_EXCLUDED_FIELDS,
} from '../../../src/core/archive/policy';
import type {
  ArchiveGatewayContinuity,
  ArchiveJob,
  ArchivePeriodicRun,
} from '../../../src/core/archive/types';
import { ARCHIVE_RESCAN_SAFETY_MS } from '../../../src/core/archive/continuity';
import { createLogger } from '../../../src/core/logger';
import type { Translator } from '../../../src/core/i18n';
import { withFreshConnection } from '../helpers/mongo';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';

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
  config: Record<string, unknown> = {},
  extra: Partial<ConstructorParameters<typeof ArchiveWorker>[0]> = {},
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
    guilds: {
      fetch: async () => ({ id: '1', channels: { cache: new Map() } }) as unknown as Guild,
    },
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
  const logger = createLogger({ level: 'silent', pretty: false });
  const translator = { t: (key: string) => key } as Translator;
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
    config: archiveRuntimeSchema.parse(config),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    guildIds: ['1'],
    logger,
    translator,
    backupNotifiers: archiveBackupNotifiers(client, translator),
    archiveRepos: buildArchiveRepos,
    writerRepos: buildArchiveWriterRepos,
    // Tests drain the inbox explicitly; the loop has its own tests.
    inboxLoop: false,
    ...extra,
  });
  return { worker, client, logger };
};

const runs = (connection: Parameters<Parameters<typeof withFreshConnection>[0]>[0]) =>
  connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
const inventory = (
  channels: { id: string; name: string }[],
  gaps: { pass: string; channelId?: string; reason: string }[] = [],
  hidden: { id: string; name: string }[] = [],
) => {
  const readable = channels.map((channel) => ({
    ...channel,
    type: ChannelType.GuildText,
    parentId: null,
  }));
  vi.mocked(collectChannels).mockResolvedValue({
    channels: readable,
    liveChannelIds: new Set([...channels, ...hidden].map((channel) => channel.id)),
    gaps,
    complete: gaps.length === 0,
    locations: [...channels, ...hidden].map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: ChannelType.GuildText,
      passes: ['channels'],
    })),
  } as unknown as Awaited<ReturnType<typeof collectChannels>>);
};

type Db = Parameters<Parameters<typeof withFreshConnection>[0]>[0];
/** Snowflake of the first possible message at `timestamp`. */
const snowflakeAt = (timestamp: number) => (BigInt(timestamp - 1420070400000) << 22n).toString();
const setWatermark = (connection: Db, channelId: string, timestamp: number) =>
  connection
    .collection('fetches')
    .updateOne({ channelID: channelId }, { $set: { lastMessageID: snowflakeAt(timestamp) } });
const continuityOf = (connection: Db) =>
  connection
    .collection<ArchiveGatewayContinuity & { _id: string }>('archive_gateway_continuity')
    .findOne({ _id: 'current' }, { projection: { _id: 0 } });
const checkpointOf = async (
  connection: Db,
  channelId: string,
  kind: 'periodic' | 'full-backup' = 'periodic',
) =>
  (
    (await connection.collection('archive_channels').findOne({ channelId }))?.['checkpoints'] as
      | Record<string, Record<string, unknown>>
      | undefined
  )?.[kind];
/** A queued full backup as the control service creates it. */
const queueFullBackup = (connection: Db, requestId = 'backup', cutoff = Date.now()) =>
  connection.collection<ArchiveJob & { _id: string }>('archive_jobs').insertOne({
    _id: `1:${requestId}`,
    jobId: `1:${requestId}`,
    requestId,
    guildId: '1',
    command: 'full-backup',
    options: { cutoff },
    runId: `full:${requestId}`,
    status: 'queued',
    cancelRequested: false,
    activeSlot: 'full-backup',
    createdAt: Date.now(),
  });
/** Waits until the wall clock passes a recorded cutoff so the next run's cutoff is newer. */
const advanceClock = (cutoff: number) =>
  vi.waitFor(() => expect(Date.now()).toBeGreaterThan(cutoff));
/** History reads for channel 10 fail while `failing` is set; channel 20 returns one message. */
const failingHistory = (client: Client, failing = true) => {
  const control = { failing };
  vi.mocked(client.rest.get).mockImplementation(async (route) => {
    if (route === '/channels/10/messages') {
      if (control.failing) throw new Error('temporary history failure');
      return [rawMessage()];
    }
    if (route === '/channels/20/messages')
      return [{ ...rawMessage(), id: '201', channel_id: '20' }];
    if (String(route).endsWith('/messages')) return [];
    return rawMessage();
  });
  return control;
};

describe('msg-archive worker integration', () => {
  it('pauses periodic backup for a full backup and resumes the same durable cutoff with separate checkpoints', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      let periodic: Promise<void> | undefined;
      let periodicEnded = false;
      try {
        const state = await worker.initialize('1');
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
        const originalClaim = state.repos.jobs.claimJob.bind(state.repos.jobs);
        vi.spyOn(state.repos.jobs, 'claimJob').mockImplementation(async (...args) => {
          expect(periodicEnded).toBe(true);
          expect(state.work.periodicActive).toBe(false);
          return originalClaim(...args);
        });
        await queueFullBackup(connection);
        await worker.pollJobs('1');
        await periodic;
        expect(
          await connection.collection('archive_jobs').findOne({ jobId: '1:backup' }),
        ).toMatchObject({ status: 'complete' });
        expect(await checkpointOf(connection, '10', 'full-backup')).toMatchObject({
          runId: 'full:backup',
          complete: true,
        });
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
          progress: { messages: { scanned: 1, admitted: 1, durable: 1 } },
        });
        // Each kind kept its own checkpoint: the full backup never reset the periodic one.
        expect(await checkpointOf(connection, '10')).toMatchObject({
          runId: interrupted?.['runId'],
          complete: true,
        });
        expect(await checkpointOf(connection, '10', 'full-backup')).toMatchObject({
          runId: 'full:backup',
        });
      } finally {
        worker.cancel();
        await periodic;
        await worker.stop();
      }
    }));

  it('keeps live capture and full backups active while periodic scans default disabled', async () =>
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
          bulk: false,
          observedAt: Date.now(),
        });
        await worker.pollJobs('1');
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        expect(
          await connection.collection<StoredMessage>('messages').findOne({ _id: '101' }),
        ).toHaveProperty('deletedAt');
        await queueFullBackup(connection, 'disabled');
        await worker.pollJobs('1');
        expect(
          await connection.collection('archive_jobs').findOne({ jobId: '1:disabled' }),
        ).toMatchObject({ status: 'complete' });
        await new MongoArchiveScheduleRepo(connection, 60_000).update({ enabled: true });
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
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      const scheduled = await store.update({ enabled: true });
      const start = MongoArchiveScheduleRepo.prototype.start;
      // Control work takes the slot while the schedule claim is in flight.
      let releaseJob!: () => void;
      const jobHeld = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      let job: Promise<void> | undefined;
      const claim = vi
        .spyOn(MongoArchiveScheduleRepo.prototype, 'start')
        .mockImplementation(async function (this: MongoArchiveScheduleRepo) {
          const result = await start.call(this);
          job = state.work.runJob(
            async () => false,
            async () => undefined,
            () => jobHeld,
          );
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
        releaseJob();
        await job;
        await worker.scheduledPeriodic('1', 60_000);
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          status: 'complete',
        });
      } finally {
        claim.mockRestore();
        releaseJob();
        await job;
        await worker.stop();
      }
    }));

  it('notifies once after three failed passes and once on recovery, without repeating after a restart', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const notifications = { send: vi.fn(async () => ({ id: '90' })), patch: vi.fn() };
      const first = fixture(manager, rawMessage, notifications);
      const failing = failingHistory(first.client);
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true });
      const due = () =>
        connection
          .collection<{ _id: string }>('archive_schedule')
          .updateOne({ _id: 'current' }, { $set: { nextRunAt: 0 } });
      const titles = () =>
        notifications.send.mock.calls.map(
          (call) => (call as unknown as [{ embeds: { title: string }[] }])[0].embeds[0]?.title,
        );
      try {
        for (let pass = 0; pass < 4; pass += 1) {
          await first.worker.scheduledPeriodic('1', 60_000);
          await due();
          if (pass === 1) expect(notifications.send).not.toHaveBeenCalled();
        }
        expect(titles()).toEqual(['replies:archive.notice_failing_title']);
      } finally {
        await first.worker.stop();
      }
      const second = fixture(manager, rawMessage, notifications);
      failingHistory(second.client, false);
      expect(failing.failing).toBe(true);
      try {
        await second.worker.scheduledPeriodic('1', 60_000);
        expect(titles()).toEqual([
          'replies:archive.notice_failing_title',
          'replies:archive.notice_recovered_title',
        ]);
        await due();
        await second.worker.scheduledPeriodic('1', 60_000);
        expect(notifications.send).toHaveBeenCalledTimes(2);
      } finally {
        await second.worker.stop();
      }
    }));

  it('counts capture-only skips as failures and lets a pass complete with gaps reset the streak', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      const due = () =>
        connection
          .collection<{ _id: string }>('archive_schedule')
          .updateOne({ _id: 'current' }, { $set: { nextRunAt: 0 } });
      try {
        const state = await worker.initialize('1');
        await store.update({ enabled: true });
        state.ready = false;
        await worker.scheduledPeriodic('1', 60_000);
        await due();
        await worker.scheduledPeriodic('1', 60_000);
        await due();
        expect(await store.read()).toMatchObject({ failureStreak: 2, running: false });
        expect(await connection.collection('archive_periodic_runs').countDocuments()).toBe(0);
        state.ready = true;
        inventory(
          [{ id: '10', name: 'room' }],
          [{ pass: 'history', channelId: '11', reason: 'missing-view-channel' }],
          [{ id: '11', name: 'hidden' }],
        );
        await worker.scheduledPeriodic('1', 60_000);
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          result: { gaps: ['11: missing-view-channel'] },
        });
        expect(await store.read()).toMatchObject({ failureStreak: 0 });
      } finally {
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
        expect(stopped.publication.heartbeat).toBeUndefined();
        expect(stopped.publication.notifications).toBeUndefined();
        await worker.capture({
          eventId: 'paused-delete',
          guildId: '1',
          channelId: '10',
          messageId: '102',
          kind: 'delete',
          bulk: false,
          observedAt: Date.now(),
        });
        await worker.drainInbox('1');
        expect(
          await connection.collection<StoredMessage>('messages').findOne({ _id: '102' }),
        ).toHaveProperty('deletedAt');
        await worker.periodic('1', async () => true);
        expect(
          await connection.collection<StoredMessage>('messages').findOne({ _id: '101' }),
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
        expect(state.reactions.generations.size).toBe(0);
        expect((await state.repos.channels.listChannels())[0]?.checkpoints?.periodic).toMatchObject(
          {
            complete: false,
            scanned: 0,
          },
        );
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

  it("builds each guild's repositories and panel publisher once, through the injected factories", async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const archiveRepos = vi.fn(buildArchiveRepos);
      const publish = vi.fn(async (): Promise<ArchivePanelDelivery> => 'skipped');
      const backupNotifiers = vi.fn(() => ({ publish }));
      const { worker } = fixture(
        manager,
        rawMessage,
        undefined,
        {},
        {
          archiveRepos,
          backupNotifiers,
        },
      );
      try {
        const state = await worker.initialize('1');
        await worker.initialize('1');
        await worker.pollJobs('1');
        await worker.periodic('1');
        expect(archiveRepos).toHaveBeenCalledOnce();
        expect(archiveRepos).toHaveBeenCalledWith(state.conn);
        expect(backupNotifiers).toHaveBeenCalledOnce();
        expect(backupNotifiers).toHaveBeenCalledWith(archiveRepos.mock.results[0]?.value.control);
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
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(stored?.content).toBe('hello');
        expect(stored?.schemaVersion).toBe(3);
        const channel = await connection
          .collection('archive_channels')
          .findOne({ channelId: '10' });
        expect(channel?.checkpoints.periodic.complete).toBe(true);
        expect(channel?.checkpoints.periodic.cutoff).toBeTypeOf('number');
        expect(channel?.checkpoints['full-backup']).toBeUndefined();
        // Each finished pass leaves one record for `/archive status`.
        const run = await runs(connection).findOne({ _id: 'current' });
        expect(
          await connection.collection('archive_jobs').find({ command: 'periodic' }).toArray(),
        ).toEqual([
          expect.objectContaining({
            status: 'complete',
            runId: run?.runId,
            result: expect.objectContaining({ cutoff: run?.cutoff, issueCount: 0 }),
            finishedAt: expect.any(Number),
          }),
        ]);
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
          bulk: false,
          observedAt: Date.now(),
        });
        await worker.drainInbox('1');
        await worker.periodic('1');
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(stored?.deletedAt).toBeDefined();
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
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('resumes a partial periodic cutoff across worker restarts and then rescans the downtime incrementally', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      vi.mocked(first.client.rest.get).mockRejectedValueOnce(
        new Error('temporary history failure'),
      );
      await first.worker.periodic('1');
      const interrupted = await connection.collection('archive_periodic_runs').findOne({});
      expect(interrupted).toMatchObject({ status: 'partial', full: true });
      await first.worker.stop();
      const downtimeFrom = (await continuityOf(connection))!.confirmedAt;
      const second = fixture(manager);
      try {
        await second.worker.periodic('1');
        const resumed = await connection.collection('archive_periodic_runs').findOne({});
        expect(resumed?.runId).toBe(interrupted?.runId);
        expect(resumed?.cutoff).toBe(interrupted?.cutoff);
        expect(resumed?.status).toBe('complete');
        // The resumed full run settles the full requirement but not the restart,
        // which its sources completed before the restart did not cover.
        expect(await continuityOf(connection)).toMatchObject({
          fullRequired: false,
          breaks: [{ index: 1, start: downtimeFrom, channelId: null }],
        });
        // A watermark newer than the downtime must not hide changes made during it.
        await setWatermark(connection, '10', Date.now() + 86_400_000);
        await advanceClock(resumed!.cutoff);
        await second.worker.periodic('1');
        const fresh = await runs(connection).findOne({ _id: 'current' });
        const rescanFrom = downtimeFrom - ARCHIVE_RESCAN_SAFETY_MS;
        expect(fresh?.runId).not.toBe(resumed?.runId);
        expect(fresh).toMatchObject({ status: 'complete', full: false, rescanFrom });
        expect((await checkpointOf(connection, '10'))?.['lower']).toBe(
          snowflakeAt(rescanFrom - 60 * 60_000),
        );
        expect(await continuityOf(connection)).toMatchObject({ breaks: [] });
        await advanceClock(fresh!.cutoff);
        await second.worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).not.toHaveProperty('rescanFrom');
      } finally {
        await second.worker.stop();
      }
    }));
  it('keeps only the interaction record of an unlisted bot reply and nothing of other bot messages', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const bot = { id: '1000', username: 'app', bot: true };
      const reply = {
        ...rawMessage(),
        author: bot,
        application_id: '1000',
        type: 20,
        content: 'reply body',
        embeds: [{ description: 'reply embed' }],
        edited_timestamp: null,
        interaction_metadata: { id: '900', type: 2, user: { id: '2000', username: 'member' } },
      };
      const { worker, client } = fixture(manager);
      vi.mocked(client.rest.get).mockImplementation(async (route) =>
        String(route).endsWith('/messages')
          ? [reply, { ...rawMessage(), id: '102', author: bot, content: 'plain bot message' }]
          : reply,
      );
      try {
        await worker.periodic('1');
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(1);
        const record = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(record).toEqual({
          _id: '101',
          schemaVersion: 3,
          channelId: '10',
          createdTimestamp: Date.parse(rawMessage().timestamp),
          observedAt: expect.any(Number),
          author: { id: '1000', username: 'app', bot: true },
          applicationId: '1000',
          interactionMetadata: { id: '900', type: 2, user: { id: '2000', username: 'member' } },
          type: 20,
          excludedFields: [...INTERACTION_RECORD_EXCLUDED_FIELDS],
          policy: { version: '1', reason: 'interaction-record' },
        });
        // Editing the reply keeps it a record: no content and no edit history.
        await worker.capture({
          eventId: 'reply-edit',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'snapshot',
          observedAt: Date.now(),
          raw: { ...reply, content: 'edited reply', edited_timestamp: new Date().toISOString() },
        });
        await worker.drainInbox('1');
        const edited = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(edited).not.toHaveProperty('content');
        expect(edited).not.toHaveProperty('editHistory');
        expect(edited).not.toHaveProperty('reactionsStaleAt');
        expect(await connection.collection('archive_reactions').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('drops even the interaction record of a bot an exclude rule names', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const reply = {
        ...rawMessage(),
        author: { id: '1000', username: 'app', bot: true },
        webhook_id: '1000',
        interaction_metadata: { id: '900', type: 2, user: { id: '2000' } },
      };
      const { worker } = fixture(
        manager,
        () => reply,
        undefined,
        {},
        {
          policy: ArchivePolicySchema.parse({
            guildIds: ['1'],
            bots: [{ ruleId: 'quiet', sourceId: '1000', action: 'exclude' }],
          }),
        },
      );
      try {
        await worker.periodic('1');
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(0);
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
          bulk: false,
          observedAt: 200,
        });
        await worker.drainInbox('1');
        expect(
          (await connection.collection<StoredMessage>('messages').findOne({ _id: '101' }))?.content,
        ).toBe('hello');
        expect(
          (await connection.collection<StoredMessage>('messages').findOne({ _id: '102' }))
            ?.deletedAt,
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

  it('records live edits once in the edit history, whatever order or repetition they arrive in', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const base = Date.now() - 10_000;
      const versions = [
        { content: 'A', edited_timestamp: null },
        { content: 'B', edited_timestamp: new Date(base + 1000).toISOString() },
        { content: 'C', edited_timestamp: new Date(base + 2000).toISOString() },
      ];
      let current = versions[0]!;
      const { worker } = fixture(manager, () => ({ ...rawMessage(), ...current }));
      const capture = (eventId: string, index: number, observedAt: number) =>
        worker.capture({
          eventId,
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'snapshot',
          observedAt,
          raw: { ...rawMessage(), ...versions[index]! },
        });
      try {
        for (const [index, version] of versions.entries()) {
          current = version;
          await capture(`version:${index}`, index, base + index * 1000 + 1);
          await worker.drainInbox('1');
        }
        // A redelivered older edit and a replay of the latest one change nothing.
        await capture('version:1', 1, base + 1001);
        await capture('version:2', 2, base + 2001);
        await worker.drainInbox('1');
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(stored?.content).toBe('C');
        expect(
          (stored?.editHistory as { content: string; editedTimestamp: number | null }[]).map(
            (entry) => [entry.content, entry.editedTimestamp],
          ),
        ).toEqual([
          ['A', null],
          ['B', base + 1000],
        ]);
      } finally {
        await worker.stop();
      }
    }));

  it('keeps no bot content in the inbox for an empty bot allowlist', async () =>
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
        expect(pending?.payload.snapshot.author).toEqual({
          id: '1000',
          username: 'bot',
          bot: true,
        });
        expect(pending?.payload.snapshot).not.toHaveProperty('content');
        expect(pending?.payload.snapshot).not.toHaveProperty('embeds');
        await worker.drainInbox('1');
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));
  it('completes a pass with a hidden channel as a known gap and then advances incrementally', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      inventory(
        [{ id: '10', name: 'room' }],
        [{ pass: 'history', channelId: '11', reason: 'missing-view-channel' }],
        [{ id: '11', name: 'hidden' }],
      );
      try {
        await worker.periodic('1');
        const first = await runs(connection).findOne({ _id: 'current' });
        expect(first).toMatchObject({
          status: 'complete',
          full: true,
          result: { issues: [], gaps: ['11: missing-view-channel'] },
          progress: { state: 'complete', gaps: [{ sourceId: '11', reason: 'permission' }] },
        });
        expect(
          await connection.collection('archive_channels').findOne({ channelId: '11' }),
        ).toMatchObject({ access: 'denied' });
        await advanceClock(first!.cutoff);
        await worker.periodic('1');
        const second = await runs(connection).findOne({ _id: 'current' });
        expect(second).toMatchObject({
          status: 'complete',
          full: false,
          result: { issues: [], gaps: ['11: missing-view-channel'] },
        });
        expect(second!.runId).not.toBe(first!.runId);
        expect(second!.cutoff).toBeGreaterThan(first!.cutoff);
        const checkpoint = await checkpointOf(connection, '10');
        expect(checkpoint).toMatchObject({ runId: second!.runId, complete: true });
        // Incremental passes stop at the previous completed watermark.
        expect(checkpoint?.['lower']).toBeTypeOf('string');
      } finally {
        await worker.stop();
      }
    }));

  it('resumes a blocked run at most three times, then closes it and retries only unfinished sources', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      inventory([
        { id: '10', name: 'room' },
        { id: '20', name: 'other' },
      ]);
      await worker.initialize('1');
      await connection
        .collection('fetches')
        .insertOne({ channelID: '10', channel: 'room', lastMessageID: '50' });
      const history = failingHistory(client);
      try {
        await worker.periodic('1');
        const blocked = await runs(connection).findOne({ _id: 'current' });
        expect(blocked).toMatchObject({ status: 'partial', full: true, blockedPasses: 1 });
        for (let resume = 1; resume <= 3; resume += 1) {
          await worker.periodic('1');
          expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
            runId: blocked!.runId,
            cutoff: blocked!.cutoff,
            status: 'partial',
            blockedPasses: resume + 1,
          });
        }
        history.failing = false;
        await advanceClock(blocked!.cutoff);
        await worker.periodic('1');
        const next = await runs(connection).findOne({ _id: 'current' });
        expect(next).toMatchObject({ status: 'complete', full: false, fullChannelIds: ['10'] });
        expect(next!.runId).not.toBe(blocked!.runId);
        expect(next!.cutoff).toBeGreaterThan(blocked!.cutoff);
        // The unfinished source is scanned fully; the completed one only incrementally.
        expect(await checkpointOf(connection, '10')).toMatchObject({
          runId: next!.runId,
          complete: true,
        });
        expect((await checkpointOf(connection, '10'))?.['lower']).toBeUndefined();
        expect(await checkpointOf(connection, '20')).toMatchObject({
          runId: next!.runId,
          complete: true,
        });
        expect((await checkpointOf(connection, '20'))?.['lower']).toBeTypeOf('string');
      } finally {
        await worker.stop();
      }
    }));

  it('carries only unfinished readable or unknown sources from a closed incremental run', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      inventory(
        [
          { id: '10', name: 'room' },
          { id: '20', name: 'other' },
        ],
        [{ pass: 'history', channelId: '40', reason: 'missing-view-channel' }],
        [
          { id: '30', name: 'unresolved' },
          { id: '40', name: 'hidden' },
        ],
      );
      const history = failingHistory(client, false);
      try {
        await worker.periodic('1');
        history.failing = true;
        await worker.periodic('1');
        const closed = await runs(connection).findOne({ _id: 'current' });
        expect(closed).toMatchObject({ status: 'partial', full: false, blockedPasses: 1 });
        expect(
          await connection.collection('archive_channels').findOne({ channelId: '30' }),
        ).toMatchObject({ access: 'unknown' });
        await runs(connection).updateOne(
          { _id: 'current' },
          { $set: { blockedPasses: 4, fullChannelIds: ['10', '20', '30', '40'] } },
        );
        history.failing = false;
        await worker.periodic('1');
        const next = await runs(connection).findOne({ _id: 'current' });
        expect(next!.runId).not.toBe(closed!.runId);
        expect(next).toMatchObject({ full: false });
        // 20 finished in the closed run and 40 is denied; both scan incrementally.
        expect([...(next!.fullChannelIds ?? [])].sort()).toEqual(['10', '30']);
      } finally {
        await worker.stop();
      }
    }));

  it.each([
    { cause: 'unknown source', expectedFull: true },
    { cause: 'Gateway gap', expectedFull: true },
    { cause: 'none', expectedFull: false },
  ] as const)(
    'keeps a full reconciliation required after closing a full run ($cause)',
    async ({ cause, expectedFull }) =>
      withFreshConnection(async (connection) => {
        const { worker, client } = fixture(new StaticConnectionManager(connection));
        inventory(
          [{ id: '10', name: 'room' }],
          [],
          cause === 'unknown source' ? [{ id: '30', name: 'unresolved' }] : [],
        );
        const history = failingHistory(client);
        try {
          await worker.periodic('1');
          await runs(connection).updateOne({ _id: 'current' }, { $set: { blockedPasses: 4 } });
          if (cause === 'Gateway gap') await worker.markGap('test gap');
          history.failing = false;
          await worker.periodic('1');
          const next = await runs(connection).findOne({ _id: 'current' });
          expect(next).toMatchObject({ full: expectedFull, blockedPasses: 0 });
          if (expectedFull) expect(next).not.toHaveProperty('fullChannelIds');
          else expect(next).toMatchObject({ fullChannelIds: ['10'] });
        } finally {
          await worker.stop();
        }
      }),
  );

  it.each([
    { run: 'incremental', warmup: true },
    { run: 'full', warmup: false },
  ] as const)(
    'does not force a full pass after resuming a $run run in the same worker',
    async ({ warmup }) =>
      withFreshConnection(async (connection) => {
        const { worker, client } = fixture(new StaticConnectionManager(connection));
        const history = failingHistory(client, false);
        try {
          if (warmup) await worker.periodic('1');
          history.failing = true;
          await worker.periodic('1');
          const blocked = await runs(connection).findOne({ _id: 'current' });
          expect(blocked).toMatchObject({ status: 'partial', full: !warmup });
          history.failing = false;
          await worker.periodic('1');
          expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
            runId: blocked!.runId,
            status: 'complete',
          });
          await worker.periodic('1');
          const next = await runs(connection).findOne({ _id: 'current' });
          expect(next!.runId).not.toBe(blocked!.runId);
          expect(next).toMatchObject({ full: false });
        } finally {
          await worker.stop();
        }
      }),
  );

  it('does not count interrupted passes toward the resume cap', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.periodic('1', async () => false);
        const paused = await runs(connection).findOne({ _id: 'current' });
        expect(paused).toMatchObject({
          status: 'partial',
          blockedPasses: 0,
          consecutiveFailures: 0,
        });
        await worker.periodic('1', async () => false);
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          runId: paused!.runId,
          blockedPasses: 0,
        });
      } finally {
        await worker.stop();
      }
    }));

  it.each([
    { observed: 'after', status: 'complete', pendingEvents: 0, liveBacklog: 1 },
    { observed: 'at', status: 'partial', pendingEvents: 1, liveBacklog: 0 },
    { observed: 'before', status: 'partial', pendingEvents: 1, liveBacklog: 0 },
  ] as const)(
    'judges completion only by inbox events observed by the cutoff ($observed)',
    async ({ observed, status, pendingEvents, liveBacklog }) =>
      withFreshConnection(async (connection) => {
        const { worker, client } = fixture(new StaticConnectionManager(connection));
        await worker.initialize('1');
        const deferred = (observedAt: number) =>
          connection.collection('archive_inbox').insertOne({
            eventId: `deferred:${observed}`,
            kind: 'delete',
            bulk: false,
            channelId: '10',
            messageId: '105',
            payload: {},
            observedAt,
            state: 'pending',
            attempts: 1,
            nextAttemptAt: Date.now() + 3_600_000,
          });
        if (observed === 'before') await deferred(Date.now() - 1000);
        let inserted = observed === 'before';
        const get = vi.mocked(client.rest.get).getMockImplementation()!;
        vi.mocked(client.rest.get).mockImplementation(async (route, options) => {
          if (!inserted && route === '/channels/10/messages') {
            inserted = true;
            const cutoff = (await runs(connection).findOne({ _id: 'current' }))!.cutoff;
            await deferred(observed === 'at' ? cutoff : cutoff + 1000);
          }
          return get(route, options);
        });
        try {
          await worker.periodic('1');
          const run = await runs(connection).findOne({ _id: 'current' });
          expect(run).toMatchObject({
            status,
            result: { counts: { pendingEvents, liveBacklog } },
            progress: { live: { pending: liveBacklog } },
          });
          const issues = (run?.result?.['issues'] ?? []) as string[];
          expect(issues.some((issue) => issue.includes('before the cutoff'))).toBe(
            observed !== 'after',
          );
        } finally {
          await worker.stop();
        }
      }),
  );

  it('logs inbox drain failures inside history hooks once without failing the source', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client, logger } = fixture(new StaticConnectionManager(connection));
      const page = Array.from({ length: 30 }, (_, index) => ({
        ...rawMessage(),
        id: String(1000 + index),
      }));
      vi.mocked(client.rest.get).mockImplementation(async (route) =>
        route === '/channels/10/messages' ? page : rawMessage(),
      );
      const warn = vi.spyOn(logger, 'warn');
      const state = await worker.initialize('1');
      // The pass-level drain before the scan finds an empty inbox; every later read fails.
      const claim = vi
        .spyOn(state.repos.inbox, 'claimInboxBatch')
        .mockResolvedValueOnce([])
        .mockRejectedValue(new Error('inbox unavailable'));
      try {
        await worker.periodic('1');
        expect(claim.mock.calls.length).toBeGreaterThan(1);
        expect(
          warn.mock.calls.filter(
            (call: readonly unknown[]) =>
              call[1] === 'Archive inbox drain deferred during history scan',
          ),
        ).toHaveLength(1);
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          result: { issues: [] },
        });
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(30);
      } finally {
        claim.mockRestore();
        await worker.stop();
      }
    }));

  it('schedules a thrown pass with exponential backoff without counting it toward the cap', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const store = new MongoArchiveScheduleRepo(connection, 3_600_000);
      await store.update({ enabled: true });
      (client.guilds as unknown as { fetch: () => Promise<never> }).fetch = async () => {
        throw new Error('guild unavailable');
      };
      try {
        for (const [failures, delay] of [
          [1, ARCHIVE_PERIODIC_RETRY_DELAY_MS],
          [2, ARCHIVE_PERIODIC_RETRY_DELAY_MS * 2],
          [3, ARCHIVE_PERIODIC_RETRY_DELAY_MS * 4],
        ] as const) {
          await connection
            .collection('archive_schedule')
            .updateOne({ _id: 'current' as never }, { $set: { nextRunAt: 0 } });
          const before = Date.now();
          await expect(worker.scheduledPeriodic('1', 3_600_000)).rejects.toThrow(
            'guild unavailable',
          );
          const after = Date.now();
          expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
            status: 'partial',
            blockedPasses: 0,
            consecutiveFailures: failures,
          });
          const { nextRunAt, running } = await store.read();
          expect(running).toBe(false);
          expect(nextRunAt).toBeGreaterThanOrEqual(before + delay);
          expect(nextRunAt).toBeLessThanOrEqual(after + delay);
        }
      } finally {
        await worker.stop();
      }
    }));

  it('schedules a pass that reached its end with blocking failures after the full interval', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const store = new MongoArchiveScheduleRepo(connection, 3_600_000);
      await store.update({ enabled: true });
      vi.mocked(client.rest.get).mockRejectedValue(new Error('temporary history failure'));
      try {
        const before = Date.now();
        await worker.scheduledPeriodic('1', 3_600_000);
        const after = Date.now();
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'partial',
          blockedPasses: 1,
          consecutiveFailures: 0,
        });
        const { nextRunAt } = await store.read();
        expect(nextRunAt).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(nextRunAt).toBeLessThanOrEqual(after + 3_600_000);
      } finally {
        await worker.stop();
      }
    }));
  it('does not treat dirty-table eviction from heavy live capture as a Gateway gap', async () =>
    withFreshConnection(async (connection) => {
      const maxPendingEvents = 5;
      const { worker } = fixture(new StaticConnectionManager(connection), rawMessage, undefined, {
        max_pending_events: maxPendingEvents,
      });
      const total = maxPendingEvents * 10 + 100;
      // Capture during the scan's discovery, before its history reads start.
      const discover = vi.mocked(collectChannels).getMockImplementation()!;
      let captured = false;
      vi.mocked(collectChannels).mockImplementationOnce(async (...args) => {
        captured = true;
        for (let index = 0; index < total; index += 1)
          await worker.capture({
            eventId: `flood:${index}`,
            guildId: '1',
            channelId: '10',
            messageId: String(5000 + index),
            kind: 'delete',
            bulk: false,
            observedAt: Date.now(),
          });
        return discover(...args);
      });
      try {
        const state = await worker.initialize('1');
        await worker.periodic('1');
        expect(captured).toBe(true);
        const run = await runs(connection).findOne({ _id: 'current' });
        expect(run).toMatchObject({ status: 'complete', result: { issues: [] } });
        expect(JSON.stringify(run?.result)).not.toContain('Gateway gap');
        expect(state.continuity.gapVersion).toBe(0);
        expect(state.dirty.size).toBeLessThanOrEqual(maxPendingEvents * 10);
        // Acknowledged events leave the dirty table once no reader needs them.
        while ((await connection.collection('archive_inbox').countDocuments()) > 0)
          await worker.drainInbox('1');
        expect(state.dirty.size).toBe(0);
        expect(state.captureVersions.size).toBe(0);
      } finally {
        await worker.stop();
      }
    }));

  const liveSnapshot = (eventId: string, messageId = '101') => ({
    eventId,
    guildId: '1',
    channelId: '10',
    messageId,
    kind: 'snapshot' as const,
    observedAt: Date.now(),
    raw: { ...rawMessage(), id: messageId },
  });
  const discordError = (code: number, status: number) =>
    Object.assign(new Error(`Discord API error ${code}`), { code, status });

  const inboxOf = (connection: Db) => connection.collection('archive_inbox');
  /** Outlasts the repository's short empty-inbox cache after editing an event directly. */
  const edit = async (connection: Db, eventId: string, fields: Record<string, unknown>) => {
    await inboxOf(connection).updateOne({ eventId }, { $set: fields });
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  const seedChannel = (connection: Db) =>
    connection
      .collection('archive_channels')
      .insertOne({ channelId: '10', name: 'room', type: 0, observedAt: 1, access: 'readable' });
  /** Live reconciliation of message 105 fails with `error`; history reads still succeed. */
  const failingReconcile = (client: Client, error: unknown) => {
    const get = vi.mocked(client.rest.get).getMockImplementation()!;
    vi.mocked(client.rest.get).mockImplementation(async (route, options) => {
      if (route === '/channels/10/messages/105') throw error;
      return get(route, options);
    });
  };

  it.each([
    { name: '10008', error: discordError(10008, 404), outcome: 'tombstoned', gaps: [] },
    { name: '10003', error: discordError(10003, 404), outcome: 'deleted', gaps: [] },
    {
      name: '50001',
      error: discordError(50001, 403),
      outcome: 'denied',
      gaps: ['discord-50001-forbidden'],
    },
    {
      name: '50013',
      error: discordError(50013, 403),
      outcome: 'denied',
      gaps: ['discord-50013-forbidden'],
    },
    {
      name: '403',
      error: discordError(40333, 403),
      outcome: 'denied',
      gaps: ['discord-40333-forbidden'],
    },
    {
      name: 'capacity',
      error: new ArchiveCapacityError('Archive capture blocked: storage headroom exhausted'),
      outcome: 'capacity',
      gaps: [],
    },
    { name: 'other', error: new Error('temporary REST failure'), outcome: 'retry', gaps: [] },
  ] as const)(
    'routes a failed live reconciliation by cause ($name)',
    async ({ error, outcome, gaps }) =>
      withFreshConnection(async (connection) => {
        const { worker, client } = fixture(new StaticConnectionManager(connection));
        vi.mocked(client.rest.get).mockRejectedValue(error);
        try {
          const state = await worker.initialize('1');
          await seedChannel(connection);
          await worker.capture(liveSnapshot('live:1'));
          const before = Date.now();
          await worker.drainInbox('1');
          const event = await inboxOf(connection).findOne({ eventId: 'live:1' });
          const channel = await connection
            .collection('archive_channels')
            .findOne({ channelId: '10' });
          const message = await connection
            .collection<StoredMessage>('messages')
            .findOne({ _id: '101' });
          if (outcome === 'tombstoned') {
            expect(event).toBeNull();
            expect(message?.deletedAt).toBeDefined();
          } else if (outcome === 'deleted' || outcome === 'denied') {
            // Terminal: the gap is recorded on the source and the event is acknowledged.
            expect(event).toBeNull();
            expect(message?.content).toBe('hello');
            expect(channel).toMatchObject({
              name: 'room',
              type: 0,
              access: outcome,
              discovery: { runId: 'live', gaps },
            });
          } else {
            expect(channel).toMatchObject({ access: 'readable' });
            expect(event).toMatchObject({
              state: 'pending',
              attempts: outcome === 'capacity' ? 0 : 1,
              claims: 0,
              lastError: expect.stringContaining(error.message),
            });
            if (outcome === 'capacity') expect(event).not.toHaveProperty('firstFailedAt');
            else expect(event?.['firstFailedAt']).toBeGreaterThanOrEqual(before);
            const delay = outcome === 'capacity' ? 300_000 : 60_000;
            expect(event?.['nextAttemptAt']).toBeGreaterThanOrEqual(before + delay);
            expect(event?.['nextAttemptAt']).toBeLessThanOrEqual(Date.now() + delay);
          }
          // Retired events leave no dirty entry behind; deferred ones keep theirs.
          const retired = outcome !== 'capacity' && outcome !== 'retry';
          expect(state.captureVersions.size).toBe(retired ? 0 : 1);
          expect(state.dirty.size).toBe(retired ? 0 : 1);
          expect(state.dirty.held).toEqual({ reads: 0, pins: 0, settled: 0 });
        } finally {
          await worker.stop();
        }
      }),
  );

  it('classifies a failed reaction refresh by the Discord error behind it', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      vi.mocked(client.rest.get).mockImplementation(async (route) => {
        if (String(route).includes('/reactions/')) throw discordError(50013, 403);
        return {
          ...rawMessage(),
          reactions: [{ emoji: { name: 'x' }, count: 1, count_details: { normal: 1, burst: 0 } }],
        };
      });
      try {
        await worker.initialize('1');
        await seedChannel(connection);
        await worker.capture(liveSnapshot('live:1'));
        await worker.drainInbox('1');
        expect(await inboxOf(connection).findOne({ eventId: 'live:1' })).toBeNull();
        expect(
          await connection.collection('archive_channels').findOne({ channelId: '10' }),
        ).toMatchObject({ access: 'denied', discovery: { gaps: ['discord-50013-forbidden'] } });
      } finally {
        await worker.stop();
      }
    }));

  it('retries a coverage gap that could not be recorded as a counted failure', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      vi.mocked(client.rest.get).mockRejectedValue(discordError(50001, 403));
      try {
        const state = await worker.initialize('1');
        await seedChannel(connection);
        vi.spyOn(state.repos.channels, 'upsertChannel').mockRejectedValueOnce(
          new Error('write failed'),
        );
        await worker.capture(liveSnapshot('live:1'));
        await worker.drainInbox('1');
        expect(await inboxOf(connection).findOne({ eventId: 'live:1' })).toMatchObject({
          state: 'pending',
          attempts: 1,
        });
        expect(
          await connection.collection('archive_channels').findOne({ channelId: '10' }),
        ).toMatchObject({ access: 'readable' });
      } finally {
        await worker.stop();
      }
    }));

  it('propagates programmer errors uncounted and dead-letters an event that keeps crashing', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client, logger } = fixture(new StaticConnectionManager(connection));
      vi.mocked(client.rest.get).mockRejectedValue(new TypeError('raw.id is not a function'));
      const error = vi.spyOn(logger, 'error');
      try {
        await worker.initialize('1');
        await worker.capture(liveSnapshot('live:1'));
        await expect(worker.drainInbox('1')).rejects.toThrow(TypeError);
        // The claim streak stays, so the crash cannot repeat forever.
        expect(await inboxOf(connection).findOne({ eventId: 'live:1' })).toMatchObject({
          state: 'pending',
          attempts: 0,
          claims: 1,
        });
        for (let round = 2; round <= 50; round += 1)
          await expect(worker.drainInbox('1')).rejects.toThrow(TypeError);
        await worker.drainInbox('1');
        expect(await inboxOf(connection).findOne({ eventId: 'live:1' })).toMatchObject({
          state: 'dead',
          lastError: 'Archive inbox claim limit',
        });
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({ eventId: 'live:1' }),
          'Archive inbox event dead-lettered',
        );
      } finally {
        await worker.stop();
      }
    }));

  it.each(['capture', 'inbox'] as const)(
    'acknowledges a failed reconciliation superseded by a newer %s event uncounted',
    async (newer) =>
      withFreshConnection(async (connection) => {
        const { worker, client } = fixture(new StaticConnectionManager(connection));
        const get = vi.mocked(client.rest.get).getMockImplementation()!;
        let failed = false;
        vi.mocked(client.rest.get).mockImplementation(async (route, options) => {
          if (route === '/channels/10/messages/105' && !failed) {
            failed = true;
            if (newer === 'capture') await worker.capture(liveSnapshot('newer', '105'));
            else
              await inboxOf(connection).insertOne({
                eventId: 'newer',
                kind: 'snapshot',
                channelId: '10',
                messageId: '105',
                payload: {},
                observedAt: Date.now() + 1000,
                state: 'pending',
                attempts: 0,
                nextAttemptAt: Date.now() + 3_600_000,
              });
            throw new Error('temporary REST failure');
          }
          return get(route, options);
        });
        try {
          const state = await worker.initialize('1');
          await worker.capture({ ...liveSnapshot('older', '105'), observedAt: Date.now() - 1000 });
          await worker.drainInbox('1');
          expect(failed).toBe(true);
          expect(await inboxOf(connection).findOne({ eventId: 'older' })).toBeNull();
          if (newer === 'capture') {
            // The newer event was reconciled in the same drain.
            expect(await inboxOf(connection).countDocuments()).toBe(0);
            expect(state.dirty.size).toBe(0);
          } else
            expect(await inboxOf(connection).findOne({ eventId: 'newer' })).toMatchObject({
              attempts: 0,
            });
          expect(state.captureVersions.has('older')).toBe(false);
        } finally {
          await worker.stop();
        }
      }),
  );

  it('retries transient failures uncounted and dead-letters them a day after the first', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      failingReconcile(client, discordError(0, 503));
      try {
        const state = await worker.initialize('1');
        await worker.capture(liveSnapshot('flaky', '105'));
        const before = Date.now();
        await worker.drainInbox('1');
        const event = await inboxOf(connection).findOne({ eventId: 'flaky' });
        expect(event).toMatchObject({ state: 'pending', attempts: 0 });
        expect(event?.['firstFailedAt']).toBeGreaterThanOrEqual(before);
        expect(event?.['nextAttemptAt']).toBeGreaterThanOrEqual(before + 60_000);
        await edit(connection, 'flaky', {
          nextAttemptAt: 0,
          firstFailedAt: Date.now() - 86_400_000,
        });
        await worker.drainInbox('1');
        expect(await inboxOf(connection).findOne({ eventId: 'flaky' })).toMatchObject({
          state: 'dead',
          attempts: 0,
        });
        expect(state.captureVersions.size).toBe(0);
        expect(state.dirty.size).toBe(0);
      } finally {
        await worker.stop();
      }
    }));

  it.each([
    { claims: 49, state: null },
    { claims: 50, state: 'dead' },
  ] as const)(
    'dead-letters an event whose claims never reached an outcome (claims=$claims)',
    async ({ claims, state }) =>
      withFreshConnection(async (connection) => {
        const { worker } = fixture(new StaticConnectionManager(connection));
        try {
          await worker.initialize('1');
          await inboxOf(connection).insertOne({
            eventId: 'crashy',
            kind: 'delete',
            bulk: false,
            channelId: '10',
            messageId: '105',
            payload: {},
            observedAt: Date.now(),
            state: 'pending',
            attempts: 0,
            claims,
          });
          await worker.drainInbox('1');
          const event = await inboxOf(connection).findOne({ eventId: 'crashy' });
          if (state === null) expect(event).toBeNull();
          else
            expect(event).toMatchObject({
              state,
              claims: claims + 1,
              lastError: 'Archive inbox claim limit',
            });
        } finally {
          await worker.stop();
        }
      }),
  );

  it('backs off counted failures, dead-letters after ten and traces the source into the next run', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const control = await archiveControlFor(connection);
      try {
        const state = await worker.initialize('1');
        // A first full pass makes the following runs incremental.
        await worker.periodic('1');
        failingReconcile(client, new Error('poison event'));
        await worker.capture(liveSnapshot('poison', '105'));
        for (const attempts of [1, 2, 3]) {
          const before = Date.now();
          await worker.drainInbox('1');
          const event = await inboxOf(connection).findOne({ eventId: 'poison' });
          expect(event).toMatchObject({ state: 'pending', attempts });
          expect(event?.['nextAttemptAt']).toBeGreaterThanOrEqual(
            before + 60_000 * 2 ** (attempts - 1),
          );
          await edit(connection, 'poison', { nextAttemptAt: 0 });
        }
        // The tenth counted failure still retries, at the one-hour cap.
        await edit(connection, 'poison', { attempts: 9 });
        let before = Date.now();
        await worker.drainInbox('1');
        const tenth = await inboxOf(connection).findOne({ eventId: 'poison' });
        expect(tenth).toMatchObject({ state: 'pending', attempts: 10 });
        expect(tenth?.['nextAttemptAt']).toBeGreaterThanOrEqual(before + 3_600_000);
        await edit(connection, 'poison', { nextAttemptAt: 0 });
        await worker.drainInbox('1');
        const dead = await inboxOf(connection).findOne({ eventId: 'poison' });
        expect(dead).toMatchObject({
          state: 'dead',
          attempts: 11,
          lastError: expect.stringContaining('poison event'),
        });
        expect(dead?.['deadAt']).toBeInstanceOf(Date);
        expect(state.captureVersions.size).toBe(0);
        await inboxOf(connection).insertOne({
          eventId: 'waiting',
          kind: 'delete',
          bulk: false,
          channelId: '10',
          messageId: '106',
          payload: {},
          observedAt: Date.now() + 3_600_000,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: Date.now() + 3_600_000,
        });
        expect(await control.deadLetterCount()).toBe(1);
        // The dead event was observed before the next cutoff, yet it no longer blocks;
        // its source is rescanned fully and reported as a known gap once.
        before = Date.now();
        await worker.periodic('1');
        const run = await runs(connection).findOne({ _id: 'current' });
        expect(run).toMatchObject({
          status: 'complete',
          full: false,
          fullChannelIds: ['10'],
          result: {
            issues: [],
            gaps: ['10: live-event-dead-lettered'],
            counts: { pendingEvents: 0, deadLetters: 1 },
          },
        });
        expect(await inboxOf(connection).findOne({ eventId: 'poison' })).toMatchObject({
          state: 'dead',
          tracedRunId: run?.runId,
        });
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          result: { gaps: [], counts: { deadLetters: 0 } },
        });
        expect(await runs(connection).findOne({ _id: 'current' })).not.toHaveProperty(
          'fullChannelIds',
        );
      } finally {
        await worker.stop();
      }
    }));

  it('releases evidence pins as each source completes and leaves no tracker state behind', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const snowflake = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
      const newer = snowflake(Date.now() - 60_000);
      // Older than the overlap window: fetched again by an incremental pass, never consumed.
      const older = snowflake(Date.now() - 3 * 3_600_000);
      vi.mocked(client.rest.get).mockImplementation(async (route) =>
        route === '/channels/10/messages'
          ? [
              { ...rawMessage(), id: newer },
              { ...rawMessage(), id: older },
            ]
          : rawMessage(),
      );
      try {
        const state = await worker.initialize('1');
        await worker.periodic('1');
        const pins: number[] = [];
        await worker.capture({
          eventId: 'live-delete',
          guildId: '1',
          channelId: '10',
          messageId: '105',
          kind: 'delete',
          bulk: false,
          observedAt: Date.now(),
        });
        await worker.periodic('1', async () => {
          pins.push(state.dirty.held.pins);
          return true;
        });
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: false,
        });
        // The page pinned both messages; completing the source released the unconsumed one
        // before the final sweep, not only when the scan ended.
        expect(Math.max(...pins)).toBeGreaterThan(0);
        expect(pins.at(-1)).toBe(0);
        while ((await inboxOf(connection).countDocuments()) > 0) await worker.drainInbox('1');
        expect(state.dirty.held).toEqual({ reads: 0, pins: 0, settled: 0 });
        expect(state.dirty.size).toBe(0);
        expect(state.captureVersions.size).toBe(0);
      } finally {
        await worker.stop();
      }
    }));

  it('dead-letters an oversized inbox event without failing history sources', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      const limits = ARCHIVE_LIMITS as { pipelineBytes: number };
      const original = limits.pipelineBytes;
      const inbox = connection.collection('archive_inbox');
      try {
        await worker.initialize('1');
        await inbox.insertOne({
          eventId: 'huge',
          kind: 'delete',
          bulk: false,
          channelId: '10',
          messageId: '106',
          payload: { padding: 'x'.repeat(8192) },
          observedAt: Date.now() - 2000,
          state: 'pending',
          attempts: 0,
        });
        await worker.capture({
          eventId: 'small',
          guildId: '1',
          channelId: '10',
          messageId: '107',
          kind: 'delete',
          bulk: false,
          observedAt: Date.now() - 1000,
        });
        limits.pipelineBytes = 4096;
        await worker.periodic('1');
        expect(await inbox.findOne({ eventId: 'huge' })).toMatchObject({
          state: 'dead',
          lastError: 'Archive inbox event exceeds memory budget',
        });
        expect(await inbox.findOne({ eventId: 'small' })).toBeNull();
        expect(
          (await connection.collection<StoredMessage>('messages').findOne({ _id: '107' }))
            ?.deletedAt,
        ).toBeDefined();
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          result: { issues: [] },
        });
      } finally {
        limits.pipelineBytes = original;
        await worker.stop();
      }
    }));
});

describe('msg-archive Gateway continuity', () => {
  /** A controllable Gateway: connected through `through` (default now) or not at all. */
  const fakeGateway = () => {
    const control: { connected: boolean; through?: number } = { connected: true };
    const gateway: ArchiveGatewayReadiness = {
      confirmedThrough: (now) =>
        control.connected ? Math.min(now, control.through ?? now) : undefined,
      sessions: () => new Map(),
    };
    return { control, gateway };
  };
  /** Runs one continuity heartbeat through the worker's (faked) interval timer. */
  const heartbeat = async (
    connection: Db,
    expected: (record: ArchiveGatewayContinuity) => void,
  ) => {
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expected((await continuityOf(connection))!));
  };
  const later = async (after: number) => {
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(after));
    return Date.now();
  };
  const sessionPacket = (session: string, guilds: string[]) => ({
    t: 'READY',
    s: 1,
    d: { session_id: session, guilds: guilds.map((id) => ({ id })) },
  });
  const replaceSession = async (
    worker: ArchiveWorker,
    decoder: ArchiveGatewayDecoder,
    session: string,
    observedAt: number,
  ) => {
    for (const event of decoder.decode(sessionPacket(session, ['1', '9']), 0, observedAt))
      await worker.capture(event);
  };

  it.each([
    { shard: 'connected', connected: true },
    { shard: 'disconnected', connected: false },
  ])(
    'confirms continuity at shutdown only while connected and never past cancellation ($shard)',
    async ({ connected }) =>
      withFreshConnection(async (connection) => {
        const { control, gateway } = fakeGateway();
        control.connected = connected;
        const { worker } = fixture(
          new StaticConnectionManager(connection),
          rawMessage,
          undefined,
          {},
          { gateway },
        );
        await worker.initialize('1');
        const opened = (await continuityOf(connection))!;
        expect(opened).toMatchObject({ fullRequired: true, gapVersion: 0, breaks: [] });
        expect(opened.continuousSince).toBe(opened.confirmedAt);
        await later(opened.confirmedAt);
        worker.cancel();
        const cancelledBy = Date.now();
        await later(cancelledBy);
        await worker.stop();
        const stopped = (await continuityOf(connection))!;
        if (connected) {
          expect(stopped.confirmedAt).toBeGreaterThan(opened.confirmedAt);
          expect(stopped.confirmedAt).toBeLessThanOrEqual(cancelledBy);
        } else expect(stopped.confirmedAt).toBe(opened.confirmedAt);
      }),
  );

  it('holds confirmation back to events still being written and never moves it backwards', async () =>
    withFreshConnection(async (connection) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { control, gateway } = fakeGateway();
      const { worker } = fixture(
        new StaticConnectionManager(connection),
        rawMessage,
        undefined,
        {},
        { gateway },
      );
      try {
        const state = await worker.initialize('1');
        const opened = state.continuity.confirmedAt;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const enqueue = state.repos.inbox.enqueue.bind(state.repos.inbox);
        vi.spyOn(state.repos.inbox, 'enqueue').mockImplementationOnce(async (entry) => {
          await blocked;
          return enqueue(entry);
        });
        const observedAt = await later(opened);
        const pending = worker.capture({
          eventId: 'delete:held',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'delete',
          bulk: false,
          observedAt,
        });
        await later(observedAt);
        await heartbeat(connection, (record) => expect(record.confirmedAt).toBe(observedAt));
        release();
        await pending;
        await heartbeat(connection, (record) =>
          expect(record.confirmedAt).toBeGreaterThan(observedAt),
        );
        const confirmed = state.continuity.confirmedAt;
        control.through = opened;
        await heartbeat(connection, (record) => expect(record.confirmedAt).toBe(confirmed));
      } finally {
        vi.useRealTimers();
        await worker.stop();
      }
    }));

  it.each(['capture overflow', 'failed inbox write', 'recorded gap event'] as const)(
    'keeps a full reconciliation required across a restart after a %s',
    async (cause) =>
      withFreshConnection(async (connection) => {
        const manager = new StaticConnectionManager(connection);
        const first = fixture(manager, rawMessage, undefined, { max_pending_events: 1 });
        await first.worker.periodic('1');
        const state = await first.worker.initialize('1');
        expect(state.continuity.fullRequired).toBe(false);
        const gapVersion = state.continuity.gapVersion;
        const event = {
          eventId: 'delete:1',
          guildId: '1',
          channelId: '10',
          messageId: '101',
          kind: 'delete' as const,
          bulk: false,
          observedAt: Date.now(),
        };
        if (cause === 'capture overflow') {
          const admitted = first.worker.capture(event);
          await expect(first.worker.capture({ ...event, eventId: 'delete:2' })).rejects.toThrow(
            'queue overflow',
          );
          await admitted;
        } else if (cause === 'failed inbox write') {
          vi.spyOn(state.repos.inbox, 'enqueue').mockRejectedValueOnce(
            new Error('inbox write failed'),
          );
          await expect(first.worker.capture(event)).rejects.toThrow('inbox write failed');
        } else await first.worker.markGap('test gap');
        expect(state.continuity.fullRequired).toBe(true);
        expect(state.continuity.gapVersion).toBeGreaterThan(gapVersion);
        // Durable before the capture or gap call returned.
        expect(await continuityOf(connection)).toMatchObject({
          fullRequired: true,
          gapVersion: state.continuity.gapVersion,
        });
        await first.worker.stop();
        const second = fixture(manager);
        try {
          await second.worker.periodic('1');
          expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
            status: 'complete',
            full: true,
          });
          expect(await runs(connection).findOne({ _id: 'current' })).not.toHaveProperty(
            'rescanFrom',
          );
          expect(await continuityOf(connection)).toMatchObject({ fullRequired: false, breaks: [] });
        } finally {
          await second.worker.stop();
        }
      }),
  );

  it('flags a gap for events dropped before the guild was opened', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      await first.worker.periodic('1');
      await first.worker.stop();
      const second = fixture(manager, rawMessage, undefined, { max_pending_events: 1 });
      const event = {
        eventId: 'delete:1',
        guildId: '1',
        channelId: '10',
        messageId: '101',
        kind: 'delete' as const,
        bulk: false,
        observedAt: Date.now(),
      };
      try {
        const admitted = second.worker.capture(event);
        await expect(second.worker.capture({ ...event, eventId: 'delete:2' })).rejects.toThrow(
          'queue overflow',
        );
        await admitted;
        const state = await second.worker.initialize('1');
        expect(state.continuity.fullRequired).toBe(true);
        expect(await continuityOf(connection)).toMatchObject({ fullRequired: true, gapVersion: 1 });
      } finally {
        await second.worker.stop();
      }
    }));

  it('moves past a run gap version whose continuity write was lost before a restart', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      await first.worker.periodic('1');
      await first.worker.stop();
      // The run counted three gaps the record never saw.
      await runs(connection).updateOne({ _id: 'current' }, { $set: { 'origin.gapVersion': 3 } });
      const second = fixture(manager);
      try {
        const state = await second.worker.initialize('1');
        expect(state.continuity).toMatchObject({ gapVersion: 4, fullRequired: true });
        await advanceClock((await runs(connection).findOne({ _id: 'current' }))!.cutoff);
        await second.worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: true,
          origin: { gapVersion: 4 },
        });
        expect(state.continuity.fullRequired).toBe(false);
      } finally {
        await second.worker.stop();
      }
    }));

  it('keeps a full requirement raised while a full run was in progress', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const history = failingHistory(client);
      try {
        await worker.periodic('1');
        const blocked = await runs(connection).findOne({ _id: 'current' });
        expect(blocked).toMatchObject({ status: 'partial', full: true });
        await worker.markGap('gap after the run began');
        history.failing = false;
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          runId: blocked!.runId,
          status: 'complete',
        });
        await advanceClock(blocked!.cutoff);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({ full: true });
      } finally {
        await worker.stop();
      }
    }));

  it('records a Gateway gap for every other guild when one guild fails', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const { client, logger } = fixture(manager);
      const unavailable = new Error('guild 2 database unavailable');
      const translator = { t: (key: string) => key } as Translator;
      const worker = new ArchiveWorker({
        client,
        connections: {
          getConnection: async (guildId: string) => {
            if (guildId === '2') throw unavailable;
            return manager.getConnection(asGuildId(guildId));
          },
        } as unknown as ConnectionManager,
        registry: {
          getRepos: () => undefined,
          getChannel: () => undefined,
          getRole: () => undefined,
          listGuildIds: () => ['1', '2'],
        },
        config: archiveRuntimeSchema.parse({}),
        policy: ArchivePolicySchema.parse({ guildIds: ['1', '2'] }),
        guildIds: ['2', '1'],
        logger,
        translator,
        backupNotifiers: archiveBackupNotifiers(client, translator),
        archiveRepos: buildArchiveRepos,
        writerRepos: buildArchiveWriterRepos,
        inboxLoop: false,
      });
      try {
        const failure = await worker.markGap('gateway-disconnect').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([unavailable]);
        expect((await worker.initialize('1')).continuity.fullRequired).toBe(true);
        expect(await connection.collection('archive_inbox').findOne({ kind: 'gap' })).toMatchObject(
          { payload: { reason: 'gateway-disconnect' } },
        );
      } finally {
        await worker.stop();
      }
    }));

  it('keeps the gap flag when the gap event itself cannot be written', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.periodic('1');
        const state = await worker.initialize('1');
        const gapVersion = state.continuity.gapVersion;
        vi.spyOn(state.repos.inbox, 'enqueue').mockRejectedValueOnce(
          new Error('inbox write failed'),
        );
        const failure = await worker.markGap('gateway-disconnect').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(state.continuity).toMatchObject({ fullRequired: true, gapVersion: gapVersion + 1 });
        expect(await continuityOf(connection)).toMatchObject({
          fullRequired: true,
          gapVersion: gapVersion + 1,
        });
      } finally {
        await worker.stop();
      }
    }));

  it('keeps an applied gap event retryable until its flag is durable', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        const state = await worker.initialize('1');
        await state.repos.inbox.enqueue({
          eventId: 'gap:queued',
          kind: 'gap',
          channelId: '',
          payload: { reason: 'test' },
          observedAt: Date.now(),
        });
        vi.spyOn(state.continuity.repo, 'write').mockRejectedValueOnce(
          new Error('continuity write failed'),
        );
        await worker.drainInbox('1');
        expect(
          await connection.collection('archive_inbox').findOne({ eventId: 'gap:queued' }),
        ).toMatchObject({ state: 'pending', lastError: expect.stringContaining('continuity') });
      } finally {
        await worker.stop();
      }
    }));

  it('forces a full run for a dead letter without a source', async () =>
    withFreshConnection(async (connection) => {
      const { worker, logger } = fixture(new StaticConnectionManager(connection));
      const warn = vi.spyOn(logger, 'warn');
      try {
        await worker.periodic('1');
        await connection.collection('archive_inbox').insertOne({
          eventId: 'gap:dead',
          kind: 'gap',
          channelId: '',
          payload: {},
          observedAt: Date.now(),
          state: 'dead',
          attempts: 11,
        });
        await advanceClock((await runs(connection).findOne({ _id: 'current' }))!.cutoff);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: true,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ eventIds: ['gap:dead'] }),
          'Archive dead letter without a source; full reconciliation required',
        );
      } finally {
        await worker.stop();
      }
    }));

  it('stops writing continuity once another boot claimed the record', async () =>
    withFreshConnection(async (connection) => {
      const { worker, logger } = fixture(new StaticConnectionManager(connection));
      const warn = vi.spyOn(logger, 'warn');
      await worker.initialize('1');
      await connection
        .collection('archive_gateway_continuity')
        .updateOne({ _id: 'current' as never }, { $set: { bootId: 'successor' } });
      await worker.stop();
      expect(await continuityOf(connection)).toMatchObject({ bootId: 'successor' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(ArchiveContinuityConflictError) }),
        'Archive Gateway continuity not persisted',
      );
    }));

  it('starts with a full reconciliation when the continuity record is malformed', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      await first.worker.periodic('1');
      await first.worker.stop();
      await connection
        .collection('archive_gateway_continuity')
        .updateOne({ _id: 'current' as never }, { $set: { breaks: 'not a list' } });
      const second = fixture(manager);
      try {
        expect((await second.worker.initialize('1')).continuity.fullRequired).toBe(true);
      } finally {
        await second.worker.stop();
      }
    }));

  it('scans a source fully after the bot lost sight of it, and only then', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const decoder = new ArchiveGatewayDecoder('process');
      let visible = true;
      Object.assign(client, { user: { id: 'bot' } });
      client.channels.cache.set('10', {
        isDMBased: () => false,
        permissionsFor: () => ({ has: () => visible }),
      } as never);
      const update = async () => {
        for (const event of decoder.decode(
          { t: 'CHANNEL_UPDATE', s: 2, d: { id: '10', guild_id: '1' } },
          0,
          Date.now(),
        ))
          await worker.capture(event);
      };
      try {
        await worker.periodic('1');
        const state = await worker.initialize('1');
        const gapVersion = state.continuity.gapVersion;
        await update();
        expect(state.continuity.breaks).toEqual([]);
        visible = false;
        await update();
        expect(state.continuity.breaks).toMatchObject([{ channelId: '10' }]);
        expect(state.continuity.gapVersion).toBe(gapVersion);
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        visible = true;
        await setWatermark(connection, '10', Date.now() - 1000);
        await advanceClock((await runs(connection).findOne({ _id: 'current' }))!.cutoff);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: false,
          fullChannelIds: ['10'],
        });
        expect((await checkpointOf(connection, '10'))?.['lower']).toBeUndefined();
        expect(state.continuity.breaks).toEqual([]);
      } finally {
        await worker.stop();
      }
    }));

  it('scans a source fully in the next run once it becomes readable again', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      try {
        await worker.periodic('1');
        await connection
          .collection('archive_channels')
          .updateOne({ channelId: '10' }, { $set: { access: 'denied' } });
        await advanceClock((await runs(connection).findOne({ _id: 'current' }))!.cutoff);
        await worker.periodic('1');
        const regained = await runs(connection).findOne({ _id: 'current' });
        expect(regained).toMatchObject({ status: 'complete', full: false });
        expect(regained).not.toHaveProperty('fullChannelIds');
        expect((await worker.initialize('1')).continuity.breaks).toMatchObject([
          { channelId: '10' },
        ]);
        await advanceClock(regained!.cutoff);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          fullChannelIds: ['10'],
        });
        expect((await checkpointOf(connection, '10'))?.['lower']).toBeUndefined();
      } finally {
        await worker.stop();
      }
    }));

  it('bounds replaced sessions like restarts and settles only breaks before each run', async () =>
    withFreshConnection(async (connection) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { gateway } = fakeGateway();
      const { worker, client } = fixture(
        new StaticConnectionManager(connection),
        rawMessage,
        undefined,
        {},
        { gateway },
      );
      const decoder = new ArchiveGatewayDecoder('process');
      decoder.seed(0, 'one');
      try {
        // A full run planned before the replacement cannot settle its break.
        const history = failingHistory(client);
        await worker.periodic('1');
        const before = await runs(connection).findOne({ _id: 'current' });
        expect(before).toMatchObject({ status: 'partial', full: true });
        const state = await worker.initialize('1');
        await later(state.continuity.confirmedAt);
        await heartbeat(connection, (record) =>
          expect(record.confirmedAt).toBeGreaterThan(record.continuousSince),
        );
        const { gapVersion, confirmedAt } = state.continuity;
        for (const event of decoder.decode({ t: 'RESUMED', s: 9, d: {} }, 0, Date.now()))
          await worker.capture(event);
        expect(state.continuity.breaks).toEqual([]);
        const replacedAt = await later(confirmedAt);
        await replaceSession(worker, decoder, 'two', replacedAt);
        // Bounded, not a gap: the pending full requirement is neither raised nor cleared.
        expect(state.continuity).toMatchObject({
          gapVersion,
          fullRequired: true,
          continuousSince: replacedAt,
        });
        expect(state.continuity.breaks).toEqual([
          { index: 1, start: confirmedAt, channelId: null },
        ]);
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        await vi.waitFor(async () =>
          expect(await continuityOf(connection)).toMatchObject({ breaks: state.continuity.breaks }),
        );
        history.failing = false;
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          runId: before!.runId,
          status: 'complete',
        });
        expect(state.continuity.fullRequired).toBe(false);
        expect(state.continuity.breaks).toHaveLength(1);
        // Another replacement while the next run is in progress stays pending after it.
        await setWatermark(connection, '10', Date.now() + 86_400_000);
        const discover = vi.mocked(collectChannels).getMockImplementation()!;
        let secondBreak = 0;
        vi.mocked(collectChannels).mockImplementationOnce(async (...args) => {
          secondBreak = await later(replacedAt);
          state.continuity.confirmedAt = secondBreak;
          await replaceSession(worker, decoder, 'three', secondBreak);
          return discover(...args);
        });
        await advanceClock(replacedAt);
        await worker.periodic('1');
        const rescanFrom = confirmedAt - ARCHIVE_RESCAN_SAFETY_MS;
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: false,
          rescanFrom,
          origin: { breakIndex: 1 },
        });
        expect((await checkpointOf(connection, '10'))?.['lower']).toBe(
          snowflakeAt(rescanFrom - 60 * 60_000),
        );
        expect(state.continuity.breaks).toEqual([
          { index: 2, start: secondBreak, channelId: null },
        ]);
        await advanceClock(secondBreak);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          rescanFrom: secondBreak - ARCHIVE_RESCAN_SAFETY_MS,
          origin: { breakIndex: 2 },
        });
        expect(state.continuity.breaks).toEqual([]);
        expect(await continuityOf(connection)).toMatchObject({ breaks: [] });
      } finally {
        vi.useRealTimers();
        await worker.stop();
      }
    }));

  it('keeps the earlier restart downtime when a session is replaced before it settles', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const first = fixture(manager);
      await first.worker.periodic('1');
      await first.worker.stop();
      const downtimeFrom = (await continuityOf(connection))!.confirmedAt;
      const second = fixture(manager);
      const decoder = new ArchiveGatewayDecoder('process');
      decoder.seed(0, 'one');
      try {
        const state = await second.worker.initialize('1');
        await replaceSession(
          second.worker,
          decoder,
          'two',
          await later(state.continuity.confirmedAt),
        );
        expect(state.continuity.breaks.map((entry) => entry.start)).toEqual([
          downtimeFrom,
          state.continuity.confirmedAt,
        ]);
        await second.worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          full: false,
          rescanFrom: downtimeFrom - ARCHIVE_RESCAN_SAFETY_MS,
        });
      } finally {
        await second.worker.stop();
      }
    }));

  it('treats channel and thread events as discovery without an inbox event or full pass', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      const decoder = new ArchiveGatewayDecoder('process');
      try {
        await worker.periodic('1');
        const state = await worker.initialize('1');
        const gapVersion = state.continuity.gapVersion;
        for (const [sequence, t] of ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_DELETE'].entries())
          for (const event of decoder.decode(
            { t, s: sequence + 2, d: { id: '30', guild_id: '1', parent_id: '10' } },
            0,
            Date.now(),
          ))
            await worker.capture(event);
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        expect(state.continuity.gapVersion).toBe(gapVersion);
        expect(state.continuity.breaks).toEqual([]);
        await advanceClock((await runs(connection).findOne({ _id: 'current' }))!.cutoff);
        await worker.periodic('1');
        expect(await runs(connection).findOne({ _id: 'current' })).toMatchObject({
          status: 'complete',
          full: false,
        });
      } finally {
        await worker.stop();
      }
    }));
});

describe('msg-archive channel records and reaction cleanup', () => {
  /** A cached guild channel whose `@everyone` visibility the test controls. */
  const cachedChannel = (
    fields: { id: string; name: string; type: ChannelType; parentId: string | null },
    everyone: { visible: boolean },
    parent?: unknown,
  ) => ({
    ...fields,
    parent: parent ?? null,
    guild: { roles: { everyone: 'everyone' } },
    isDMBased: () => false,
    isThread: () =>
      fields.type === ChannelType.PublicThread || fields.type === ChannelType.PrivateThread,
    permissionsFor: (target: unknown) => ({
      has: () => (target === 'everyone' ? everyone.visible : true),
    }),
  });

  it('creates records from channel and thread creation and follows a visibility change', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const decoder = new ArchiveGatewayDecoder('process');
      const everyone = { visible: true };
      const parent = cachedChannel(
        { id: '40', name: 'news', type: ChannelType.GuildText, parentId: '5' },
        everyone,
      );
      const thread = cachedChannel(
        { id: '41', name: 'thread', type: ChannelType.PublicThread, parentId: '40' },
        everyone,
        parent,
      );
      client.channels.cache.set('40', parent as never);
      client.channels.cache.set('41', thread as never);
      const record = (channelId: string) =>
        connection
          .collection('archive_channels')
          .findOne({ channelId }, { projection: { _id: 0 } });
      const event = async (t: string, sequence: number, id: string) => {
        for (const decoded of decoder.decode(
          { t, s: sequence, d: { guild_id: '1', id } },
          0,
          Date.now(),
        ))
          await worker.capture(decoded);
      };
      try {
        await event('CHANNEL_CREATE', 2, '40');
        await event('THREAD_CREATE', 3, '41');
        expect(await record('40')).toMatchObject({
          name: 'news',
          type: ChannelType.GuildText,
          parentId: '5',
          access: 'readable',
          everyoneCanView: true,
        });
        expect(await record('41')).toMatchObject({
          name: 'thread',
          type: ChannelType.PublicThread,
          parentId: '40',
          everyoneCanView: true,
        });
        everyone.visible = false;
        await event('CHANNEL_UPDATE', 4, '40');
        expect(await record('40')).toMatchObject({ everyoneCanView: false, access: 'readable' });
      } finally {
        await worker.stop();
      }
    }));

  it('records everyone visibility in discovery, uncached threads through their parent', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const parent = cachedChannel(
        { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null },
        { visible: true },
      );
      Object.assign(client.guilds, {
        fetch: async () => ({ id: '1', channels: { cache: new Map([['10', parent]]) } }),
      });
      vi.mocked(collectChannels).mockResolvedValue({
        channels: [{ id: '10', name: 'room', type: ChannelType.GuildText, parentId: null }],
        liveChannelIds: new Set(['10', '31', '32']),
        gaps: [],
        complete: true,
        locations: [
          { id: '10', name: 'room', type: ChannelType.GuildText, passes: ['channels'] },
          {
            id: '31',
            name: 'open',
            type: ChannelType.PublicThread,
            parentId: '10',
            passes: ['threads'],
          },
          {
            id: '32',
            name: 'closed',
            type: ChannelType.PrivateThread,
            parentId: '10',
            passes: ['threads'],
          },
        ],
      } as unknown as Awaited<ReturnType<typeof collectChannels>>);
      const visibility = async (channelId: string) =>
        (await connection.collection('archive_channels').findOne({ channelId }))?.[
          'everyoneCanView'
        ];
      try {
        await worker.periodic('1');
        expect(await visibility('10')).toBe(true);
        expect(await visibility('31')).toBe(true);
        expect(await visibility('32')).toBe(false);
      } finally {
        await worker.stop();
      }
    }));

  it("keeps an unknown author's content out of the inbox and drops the message once REST shows an unlisted bot", async () =>
    withFreshConnection(async (connection) => {
      let author: Record<string, unknown> = { id: '900', username: 'bot', bot: true };
      const { worker } = fixture(new StaticConnectionManager(connection), () => ({
        ...rawMessage(),
        id: '401',
        author,
        content: 'secret',
      }));
      const partial = (eventId: string) =>
        worker.capture({
          eventId,
          guildId: '1',
          channelId: '10',
          messageId: '401',
          kind: 'snapshot',
          observedAt: Date.now(),
          raw: { id: '401', channel_id: '10', content: 'secret', embeds: [{ title: 'secret' }] },
        });
      try {
        await partial('partial-1');
        const pending = await connection
          .collection('archive_inbox')
          .findOne({ eventId: 'partial-1' });
        expect(JSON.stringify(pending?.payload)).not.toContain('secret');
        await worker.drainInbox('1');
        expect(await connection.collection('messages').countDocuments()).toBe(0);
        // A human author is stored once REST names it.
        author = { id: '901', username: 'member', bot: false };
        await partial('partial-2');
        await worker.drainInbox('1');
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '401' });
        expect(stored).toMatchObject({ content: 'secret', author: { id: '901' } });
        expect(stored).not.toHaveProperty('policy');
      } finally {
        await worker.stop();
      }
    }));

  it('reads no message for reactions on messages it does not hold or holds only as records', async () =>
    withFreshConnection(async (connection) => {
      const { worker, client } = fixture(new StaticConnectionManager(connection));
      const reaction = (eventId: string, messageId: string) =>
        worker.capture({
          eventId,
          guildId: '1',
          channelId: '10',
          messageId,
          kind: 'reaction',
          observedAt: Date.now(),
        });
      try {
        await worker.initialize('1');
        await connection.collection<StoredMessage>('messages').insertOne({
          _id: '501',
          schemaVersion: 3,
          channelId: '10',
          createdTimestamp: 1,
          observedAt: 1,
          author: { id: '900', bot: true },
          excludedFields: ['reactions'],
          policy: { version: '1', reason: 'interaction-record' },
        });
        await reaction('unknown-message', '500');
        await reaction('record', '501');
        await worker.drainInbox('1');
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
        expect(
          vi
            .mocked(client.rest.get)
            .mock.calls.filter(([route]) => String(route).includes('/messages/50')),
        ).toEqual([]);
        expect(
          await connection.collection<StoredMessage>('messages').findOne({ _id: '501' }),
        ).not.toHaveProperty('reactionsStaleAt');
      } finally {
        await worker.stop();
      }
    }));

  it.each([
    ['a legacy unique message index', 'index'],
    ['a document of an earlier schema', 'document'],
  ] as const)('stays in capture-only mode with %s', async (_label, legacy) =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const conn = await manager.getConnection(asGuildId('1'));
      await conn.models.Message.createIndexes();
      if (legacy === 'index')
        await connection.collection('messages').createIndex({ messageId: 1 }, { unique: true });
      else await connection.collection('messages').insertOne({ messageId: '1', schemaVersion: 2 });
      const { worker } = fixture(manager);
      try {
        expect((await worker.initialize('1')).ready).toBe(false);
      } finally {
        await worker.stop();
      }
    }),
  );

  it('records an unknown thread from live capture and follows its rename, permission change and deletion', async () =>
    withFreshConnection(async (connection) => {
      const threadMessage = { ...rawMessage(), id: '301', channel_id: '30' };
      const { worker, client } = fixture(
        new StaticConnectionManager(connection),
        () => threadMessage,
      );
      const decoder = new ArchiveGatewayDecoder('process');
      const everyone = { visible: true };
      const parent = cachedChannel(
        { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null },
        everyone,
      );
      const thread = cachedChannel(
        { id: '30', name: 'topic', type: ChannelType.PublicThread, parentId: '10' },
        everyone,
        parent,
      );
      client.channels.cache.set('10', parent as never);
      client.channels.cache.set('30', thread as never);
      const record = (channelId: string) =>
        connection
          .collection('archive_channels')
          .findOne({ channelId }, { projection: { _id: 0 } });
      const channelEvent = async (t: string, sequence: number, data: Record<string, unknown>) => {
        for (const event of decoder.decode(
          { t, s: sequence, d: { guild_id: '1', ...data } },
          0,
          Date.now(),
        ))
          await worker.capture(event);
      };
      try {
        await worker.capture({
          eventId: 'thread-message',
          guildId: '1',
          channelId: '30',
          messageId: '301',
          kind: 'snapshot',
          observedAt: Date.now(),
          raw: threadMessage,
        });
        await worker.drainInbox('1');
        expect(
          await connection.collection<StoredMessage>('messages').findOne({ _id: '301' }),
        ).toMatchObject({
          channelId: '30',
          content: 'hello',
        });
        expect(await record('30')).toMatchObject({
          name: 'topic',
          type: ChannelType.PublicThread,
          parentId: '10',
          access: 'readable',
          everyoneCanView: true,
        });
        // The thread left the cache; the event's own details rename it.
        client.channels.cache.delete('30');
        await channelEvent('THREAD_UPDATE', 2, {
          id: '30',
          name: 'renamed',
          type: ChannelType.PublicThread,
          parent_id: '10',
        });
        expect(await record('30')).toMatchObject({ name: 'renamed', access: 'readable' });
        everyone.visible = false;
        await channelEvent('CHANNEL_UPDATE', 3, { id: '10', name: 'room' });
        expect(await record('10')).toMatchObject({ name: 'room', everyoneCanView: false });
        await channelEvent('THREAD_DELETE', 4, {
          id: '30',
          type: ChannelType.PublicThread,
          parent_id: '10',
        });
        // Deleted channels keep their name and parent for readers.
        expect(await record('30')).toMatchObject({
          name: 'renamed',
          parentId: '10',
          access: 'deleted',
          everyoneCanView: true,
        });
        expect(await connection.collection('archive_inbox').countDocuments()).toBe(0);
      } finally {
        await worker.stop();
      }
    }));

  it('deletes old membership chunks no message references when no backup is running', async () =>
    withFreshConnection(async (connection) => {
      const { worker } = fixture(new StaticConnectionManager(connection));
      const chunk = (generation: string, observedAt: number) => ({
        messageId: '999',
        channelId: '10',
        emojiKey: '👍',
        type: 0,
        generation,
        chunk: 0,
        userIds: ['1'],
        observedAt,
      });
      try {
        await worker.initialize('1');
        await connection
          .collection('archive_reactions')
          .insertMany([chunk('orphan', Date.now() - 2 * 86_400_000), chunk('fresh', Date.now())]);
        await worker.pollJobs('1');
        expect(
          (await connection.collection('archive_reactions').find({}).toArray()).map(
            (entry) => entry.generation,
          ),
        ).toEqual(['fresh']);
      } finally {
        await worker.stop();
      }
    }));
});
