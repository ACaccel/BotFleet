import path from 'node:path';
import { createDefaultTranslator } from '../../../src/core/i18n';
import { ChannelType, type Client, type Guild, type APIEmbed } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ArchiveJob } from '../../../src/core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../src/core/archive/progress';
import type * as StorageUsageModule from '../../../src/infra/archive/storage-usage';
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
) {
  const channel = { id: '10', name: 'room', type: ChannelType.GuildText, parentId: null };
  vi.mocked(collectChannels).mockResolvedValue({
    channels: [channel],
    liveChannelIds: new Set(['10']),
    gaps: [],
    complete: true,
    locations: [],
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
          translator.t('replies:archive.public_writes', { inserted: 1, updated: 0 }),
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
