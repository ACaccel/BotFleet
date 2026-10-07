import { ArchiveControlService } from '../../../src/infra/archive/control';
import type { Client, APIEmbed } from 'discord.js';
import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveJob } from '../../../src/core/archive/types';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import type { Translator } from '../../../src/core/i18n';
import { createLogger } from '../../../src/core/logger';
import type * as StorageUsageModule from '../../../src/infra/archive/storage-usage';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { ArchiveRepairService } from '../../../src/plugins/message-backup/repair/service';
import { withFreshConnection } from '../helpers/mongo';

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

const jobId = '1:audit-lifecycle';

function fixture(connection: Connection, manager = new StaticConnectionManager(connection)) {
  const jobs = connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
  const deliveries: { content: string; job: ArchiveJob | null }[] = [];
  const record = async (content: string): Promise<void> => {
    deliveries.push({ content, job: await jobs.findOne({ jobId }) });
  };
  const send = vi.fn(async (options: { content: string; embeds: APIEmbed[] }) => {
    await record(JSON.stringify(options.embeds));
    return { id: '100' };
  });
  const patch = vi.fn(
    async (_route: string, options: { body: { content: string; embeds: APIEmbed[] } }) => {
      await record(JSON.stringify(options.body.embeds));
      return {};
    },
  );
  const worker = new ArchiveWorker({
    client: {
      rest: { patch, get: async () => ({ embeds: [], components: [] }) },
    } as unknown as Client,
    connections: manager,
    registry: {
      getRepos: () => undefined,
      getRole: () => undefined,
      getChannel: () => ({ id: '10', isSendable: () => true, send }) as never,
      listGuildIds: () => ['1'],
    },
    config: archiveRuntimeSchema.parse({ progress_interval_seconds: 10 }),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    guildIds: ['1'],
    logger: createLogger({ level: 'silent', pretty: false }),
    translator: {
      t: (key: string, values: unknown) => JSON.stringify({ key, values }),
    } as Translator,
  });
  const enqueue = (command: ArchiveJob['command'] = 'audit') =>
    jobs.insertOne({
      _id: jobId,
      jobId,
      requestId: 'audit-lifecycle',
      guildId: '1',
      command,
      options: {},
      status: 'queued',
      cancelRequested: false,
      createdAt: Date.now(),
      notification: { channelId: '10' },
    });
  return { worker, jobs, enqueue, deliveries, send, patch };
}

describe('claimed archive job lifecycle', () => {
  it('persists a ten-second heartbeat while an operation has no progress callbacks', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      let release!: () => void;
      let enter!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const execute = vi
        .spyOn(ArchiveRepairService.prototype, 'execute')
        .mockImplementationOnce(async () => {
          enter();
          await blocked;
          return { status: 'complete', counts: { total: 0 }, issues: [] };
        });
      let work: Promise<void> | undefined;
      try {
        await f.enqueue();
        work = f.worker.pollJobs('1');
        await entered;
        await expect
          .poll(async () => Boolean((await f.jobs.findOne({ jobId }))?.result?.['progress']), {
            timeout: 3000,
          })
          .toBe(true);
        const initial = (await f.jobs.findOne({ jobId }))!.result!['progress'] as {
          updatedAt: number;
          lastProgressAt: number;
        };
        await expect
          .poll(
            async () =>
              (
                (await f.jobs.findOne({ jobId }))?.result?.['progress'] as
                  | { updatedAt: number }
                  | undefined
              )?.updatedAt ?? 0,
            { timeout: 13000, interval: 100 },
          )
          .toBeGreaterThan(initial.updatedAt);
        const heartbeat = (await f.jobs.findOne({ jobId }))!;
        expect(heartbeat.status).toBe('running');
        expect(heartbeat.result?.['progress']).toMatchObject({
          lastProgressAt: initial.lastProgressAt,
          phases: { repair: { committed: 0 } },
        });
        expect(
          (heartbeat.result?.['progress'] as { elapsedMs: number }).elapsedMs,
        ).toBeGreaterThanOrEqual(9500);
        release();
        await work;
        expect((await f.jobs.findOne({ jobId }))?.status).toBe('complete');
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.patch.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        release();
        await work;
        execute.mockRestore();
        await f.worker.stop();
      }
    }));

  it('claims and executes audit when the notification replay query fails', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await f.enqueue();
        vi.spyOn(f.jobs, 'find').mockImplementationOnce(() => {
          throw new Error('notification replay query unavailable');
        });

        await f.worker.pollJobs('1');

        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 } },
        });
      } finally {
        await f.worker.stop();
      }
    }));

  it('executes audit after initial progress persistence fails and retains its completed result', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await f.worker.initialize('1');
        await f.enqueue();
        const originalUpdate = f.jobs.updateOne.bind(f.jobs);
        let failed = false;
        const updateJob = vi.spyOn(f.jobs, 'updateOne').mockImplementation(async (...args) => {
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.['result.progress'] !== undefined &&
            !failed
          ) {
            failed = true;
            throw new Error('progress persistence unavailable');
          }
          return originalUpdate(...args);
        });

        await f.worker.pollJobs('1');

        expect(failed).toBe(true);
        expect(
          updateJob.mock.calls.find(
            ([, patch]) => !Array.isArray(patch) && patch.$set?.['result.progress'] !== undefined,
          )?.[1],
        ).toMatchObject({ $set: { 'result.progress': { state: 'running' } } });
        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 }, progress: { state: 'complete' } },
          notification: { deliveredStatus: 'complete' },
        });
        const terminalDelivery = f.deliveries.find(({ job }) => job?.status === 'complete');
        expect(terminalDelivery?.job).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 } },
        });
      } finally {
        await f.worker.stop();
      }
    }));

  it('persists setup failures as terminal jobs before delivering their failed result', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await f.enqueue();
        await f.jobs.updateOne({ jobId }, { $set: { createdAt: NaN } });

        await f.worker.pollJobs('1');

        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'failed',
          result: { issues: ['Error: invalid-progress-cutoff'] },
        });
        expect(f.deliveries).toHaveLength(1);
        expect(f.deliveries[0]?.job?.status).toBe('failed');
        expect(f.deliveries[0]?.content).toContain('view_state_failed');
      } finally {
        await f.worker.stop();
      }
    }));

  it('retains completion and replays the final result when notification persistence fails', async () =>
    withFreshConnection(async (connection) => {
      const manager = new StaticConnectionManager(connection);
      const f = fixture(connection, manager);
      const originalUpdate = f.jobs.updateOne.bind(f.jobs);
      let failed = false;
      const update = vi.spyOn(f.jobs, 'updateOne').mockImplementation(async (...args) => {
        if (
          !failed &&
          !Array.isArray(args[1]) &&
          args[1].$set?.['notification.deliveredStatus'] === 'complete'
        ) {
          failed = true;
          throw new Error('notification metadata persistence unavailable');
        }
        return originalUpdate(...args);
      });
      try {
        await f.enqueue();
        await f.worker.pollJobs('1');

        expect(failed).toBe(true);
        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 }, progress: { state: 'complete' } },
          notification: { messageId: '100', deliveredStatus: 'running' },
        });
        const terminalDelivery = f.deliveries.find(({ job }) => job?.status === 'complete');
        expect(terminalDelivery?.job?.status).toBe('complete');
        expect((await f.jobs.findOne({ jobId }))?.notification?.nextAttemptAt).toBeGreaterThan(
          Date.now(),
        );
      } finally {
        update.mockRestore();
        await f.worker.stop();
      }

      await f.jobs.updateOne({ jobId }, { $set: { 'notification.nextAttemptAt': 0 } });
      const restarted = fixture(connection, manager);
      try {
        await restarted.worker.pollJobs('1');
        expect(restarted.send).not.toHaveBeenCalled();
        expect(restarted.patch).toHaveBeenCalledOnce();
        expect(restarted.deliveries[0]?.content).toContain('view_state_complete');
        expect(await restarted.jobs.findOne({ jobId })).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 } },
          notification: { deliveredStatus: 'complete' },
        });
      } finally {
        await restarted.worker.stop();
      }
    }));

  it('does not change a completed result when Discord rejects the final notification', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await f.enqueue();
        f.patch.mockImplementation(async (_route, options) => {
          if (!JSON.stringify(options.body.embeds).includes('view_state_complete')) return {};
          const saved = await f.jobs.findOne({ jobId });
          expect(saved).toMatchObject({ status: 'complete', result: { counts: { total: 0 } } });
          expect(JSON.stringify(options.body.embeds)).toContain('view_state_complete');
          throw new Error('Discord temporarily unavailable');
        });

        await f.worker.pollJobs('1');

        expect(
          f.patch.mock.calls.filter(([, options]) =>
            JSON.stringify(options.body.embeds).includes('view_state_complete'),
          ),
        ).toHaveLength(1);
        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'complete',
          result: { counts: { total: 0 }, progress: { state: 'complete' } },
          notification: { deliveredStatus: 'running' },
        });
        expect((await f.jobs.findOne({ jobId }))?.notification?.nextAttemptAt).toBeGreaterThan(
          Date.now(),
        );
      } finally {
        await f.worker.stop();
      }
    }));

  it.each(['audit', 'refresh-attachment'] as const)(
    'does not rewrite the %s result after an uncertain terminal write acknowledgement',
    async (command) =>
      withFreshConnection(async (connection) => {
        const f = fixture(connection);
        try {
          const state = await f.worker.initialize('1');
          await f.enqueue(command);
          const originalUpdate = state.repo.updateJob.bind(state.repo);
          const updates = vi.spyOn(state.repo, 'updateJob').mockImplementation(async (...args) => {
            await originalUpdate(...args);
            if (args[1].status !== undefined)
              throw new Error('terminal write acknowledgement unavailable');
          });

          await expect(f.worker.pollJobs('1')).rejects.toThrow(
            'terminal write acknowledgement unavailable',
          );

          const saved = await f.jobs.findOne({ jobId });
          if (command === 'audit') {
            expect(saved).toMatchObject({ status: 'complete', result: { counts: { total: 0 } } });
          } else {
            expect(saved).toMatchObject({
              status: 'failed',
              result: {
                issues: [
                  'TypeError: Attachment refresh requires channelId, messageId, attachmentId and userId snowflakes',
                ],
              },
            });
          }
          expect(updates.mock.calls.filter(([, patch]) => patch.status !== undefined)).toHaveLength(
            1,
          );
          expect(f.deliveries.some(({ job }) => job?.status !== 'running')).toBe(false);
        } finally {
          await f.worker.stop();
        }
      }),
  );
  it('waits for running work to quiesce before removing its record and freezing the public card', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      let release!: () => void;
      let enter!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      vi.spyOn(ArchiveRepairService.prototype, 'execute').mockImplementationOnce(async () => {
        enter();
        await blocked;
        return { status: 'cancelled', counts: { total: 7 }, issues: [] };
      });
      let work: Promise<void> | undefined;
      try {
        await f.enqueue();
        work = f.worker.pollJobs('1');
        await entered;
        const control = new ArchiveControlService(connection, '1');
        expect(await control.deleteJob(jobId)).toMatchObject({ pending: true, deleted: false });
        expect(await f.jobs.findOne({ jobId })).toMatchObject({
          status: 'running',
          cancelRequested: true,
        });
        release();
        await work;
        expect(await f.jobs.findOne({ jobId })).toBeNull();
        const final = f.patch.mock.calls.at(-1)?.[1].body;
        expect(JSON.stringify(final)).toContain('deleted_public');
        expect(final).toMatchObject({ components: [] });
      } finally {
        release();
        await work?.catch(() => undefined);
        await f.worker.stop();
        vi.restoreAllMocks();
      }
    }));
});
