import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
} from '../../../src/persistence/repositories/archive-repos';
import { archiveBackupNotifiers } from '../../../src/plugins/message-backup/runtime/backup-notifier';
import { mongo } from 'mongoose';
import { ChannelType, type Client, type Guild, type APIEmbed } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ArchiveProgressSnapshot } from '../../../src/core/archive/progress';
import type * as StorageUsageModule from '../../../src/infra/archive/storage-usage';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import { ArchiveLimitExceededError } from '../../../src/core/archive/errors';
import { ARCHIVE_LIMITS } from '../../../src/core/archive/limits';
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
  const actual = await original<typeof StorageUsageModule>();
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
    guilds: {
      fetch: async () => ({ id: '1', channels: { cache: new Map() } }) as unknown as Guild,
    },
    rest: { get, patch },
  } as unknown as Client;
  const workerTranslator =
    translator ??
    ({
      t: (key: string, values: unknown) => JSON.stringify({ key, values }),
    } as Translator);
  const worker = new ArchiveWorker({
    client,
    // Tests drain the inbox explicitly; the loop has its own tests.
    inboxLoop: false,
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
    translator: workerTranslator,
    backupNotifiers: archiveBackupNotifiers(client, workerTranslator),
    archiveRepos: buildArchiveRepos,
    writerRepos: buildArchiveWriterRepos,
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
        const previous = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(Object.keys(previous?.reactionGenerations ?? {})).toHaveLength(2);
        f.snapshot.reactions = [];
        f.get.mockClear();
        const stale = vi.spyOn(state.repos.reactions, 'markReactionsStale');
        const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
        await f.worker.periodic('1');
        expect(stale).not.toHaveBeenCalled();
        expect(finalize).not.toHaveBeenCalled();
        expect(f.get.mock.calls.some(([route]) => route.includes('/reactions/'))).toBe(false);
        const current = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(current?.reactionGenerations).toEqual({});
        expect(current?.reactionsFreshAt).toEqual(expect.any(Number));
        expect(current).not.toHaveProperty('reactionsStaleAt');
        expect(await connection.collection('archive_reactions').countDocuments()).toBe(2);
      } finally {
        await f.worker.stop();
      }
    }));

  it('marks lists stale in the page write, stages chunks together and publishes once', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        const state = await f.worker.initialize('1');
        const stale = vi.spyOn(state.repos.reactions, 'markReactionsStale');
        const stage = state.repos.reactions.stageReactions.bind(state.repos.reactions);
        let markedDuringRefresh: unknown;
        const staging = vi
          .spyOn(state.repos.reactions, 'stageReactions')
          .mockImplementation(async (...args) => {
            markedDuringRefresh = (
              await connection.collection<StoredMessage>('messages').findOne({ _id: '101' })
            )?.reactionsStaleAt;
            return stage(...args);
          });
        const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
        await f.worker.periodic('1');
        expect(stale).not.toHaveBeenCalled();
        expect(markedDuringRefresh).toEqual(expect.any(Number));
        expect(staging).toHaveBeenCalledTimes(1);
        expect(staging.mock.calls[0]?.[0].map((chunk) => [chunk.emojiKey, chunk.type])).toEqual(
          expect.arrayContaining([
            ['50', 0],
            ['50', 1],
          ]),
        );
        expect(finalize).toHaveBeenCalledTimes(1);
        const current = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(Object.keys(current?.reactionGenerations ?? {}).sort()).toEqual(['50:0', '50:1']);
        expect(current).not.toHaveProperty('reactionsStaleAt');
        expect(current?.reactionsFreshAt).toBeLessThanOrEqual(
          current?.reactionGenerations?.['50:0']?.observedAt ?? 0,
        );
      } finally {
        await f.worker.stop();
      }
    }));

  it.each([
    { reason: 'nothing changed', rereads: false },
    { reason: 'the counts changed', rereads: true },
    { reason: 'the lists are marked stale', rereads: true },
    { reason: 'a live change is unsettled', rereads: true },
    { reason: 'capture restarted after the refresh', rereads: true },
    { reason: 'the pass is a full reconciliation', rereads: true },
    { reason: 'the source is scanned fully', rereads: true },
    { reason: 'a visibility break followed the resumed run', rereads: true },
  ] as const)(
    'rereads reaction lists in a periodic pass only when needed: $reason',
    async ({ reason, rereads }) =>
      withFreshConnection(async (connection) => {
        const f = fixture(new StaticConnectionManager(connection));
        try {
          await f.worker.periodic('1');
          const state = await f.worker.initialize('1');
          const messages = connection.collection<StoredMessage>('messages');
          const before = await messages.findOne({ _id: '101' });
          expect(state.continuity.fullRequired).toBe(false);
          if (reason === 'the counts changed')
            f.snapshot.reactions = [
              {
                emoji: { id: '50', name: 'first' },
                count: 4,
                count_details: { normal: 3, burst: 1 },
              },
            ];
          else if (reason === 'the lists are marked stale')
            await state.repos.reactions.markReactionsStale('101', Date.now());
          else if (reason === 'a live change is unsettled') state.dirty.observe('101');
          else if (reason === 'capture restarted after the refresh')
            state.continuity.continuousSince = Date.now() + 1;
          else if (reason === 'the pass is a full reconciliation')
            state.continuity.fullRequired = true;
          else if (reason === 'the source is scanned fully')
            state.continuity.breaks = [
              { index: state.continuity.breakIndex + 1, start: Date.now(), channelId: '10' },
            ];
          else if (reason === 'a visibility break followed the resumed run') {
            // A blocked pass leaves a run to resume; the break comes after it was planned.
            const get = f.get.getMockImplementation()!;
            f.get.mockImplementation(async (route, options) => {
              if (route.endsWith('/messages')) throw new Error('Discord unavailable');
              return get(route, options);
            });
            await f.worker.periodic('1');
            f.get.mockImplementation(get);
            state.continuity.breaks = [
              { index: state.continuity.breakIndex + 1, start: Date.now(), channelId: '10' },
            ];
          }
          f.get.mockClear();
          const planned = await connection.collection('archive_periodic_runs').findOne({});
          await f.worker.periodic('1');
          if (reason === 'a visibility break followed the resumed run') {
            const resumed = await connection.collection('archive_periodic_runs').findOne({});
            expect(planned?.['status']).toBe('partial');
            expect(resumed).toMatchObject({ runId: planned?.['runId'], status: 'complete' });
            expect(resumed).not.toHaveProperty('fullChannelIds');
          }
          const reread = f.get.mock.calls.some(([route]) => route.includes('/reactions/'));
          expect(reread).toBe(rereads);
          const after = await messages.findOne({ _id: '101' });
          expect(after).not.toHaveProperty('reactionsStaleAt');
          if (rereads) {
            expect(after?.reactionGenerations?.['50:0']?.generation).not.toBe(
              before?.reactionGenerations?.['50:0']?.generation,
            );
          } else {
            expect(after?.reactionGenerations).toEqual(before?.reactionGenerations);
            expect(after?.reactionsFreshAt).toBe(before?.reactionsFreshAt);
            expect(state.progress?.snapshot().reactions).toMatchObject({ completed: 1 });
          }
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it.each([
    { reason: 'it was refreshed exactly when the lossless window began', outcome: 'kept' },
    { reason: 'a live change was observed and settled during the page read', outcome: 'stale' },
    { reason: 'a Gateway gap occurred during the page read', outcome: 'stale' },
    { reason: 'the page reports no count details', outcome: 'reread' },
    { reason: 'its freshness was never recorded', outcome: 'reread' },
    { reason: 'a stream is not published', outcome: 'reread' },
    { reason: 'a generation is incomplete', outcome: 'reread' },
    { reason: 'the resumed run scans the source fully after its break settled', outcome: 'reread' },
  ] as const)(
    'keeps, rereads or leaves stale the lists when $reason',
    async ({ reason, outcome }) =>
      withFreshConnection(async (connection) => {
        const f = fixture(new StaticConnectionManager(connection));
        const messages = connection.collection<StoredMessage>('messages');
        const get = f.get.getMockImplementation()!;
        const failHistory = () =>
          f.get.mockImplementation(async (route, options) => {
            if (route.endsWith('/messages')) throw new Error('Discord unavailable');
            return get(route, options);
          });
        try {
          if (reason === 'the page reports no count details')
            f.snapshot.reactions = [{ emoji: { id: '50', name: 'first' }, count: 3 } as never];
          await f.worker.periodic('1');
          const state = await f.worker.initialize('1');
          const before = await messages.findOne({ _id: '101' });
          if (reason === 'it was refreshed exactly when the lossless window began')
            state.continuity.continuousSince = before?.reactionsFreshAt;
          else if (reason === 'its freshness was never recorded')
            await messages.updateOne({ _id: '101' }, { $unset: { reactionsFreshAt: 1 } });
          else if (reason === 'a stream is not published')
            await messages.updateOne({ _id: '101' }, { $unset: { 'reactionGenerations.50:1': 1 } });
          else if (reason === 'a generation is incomplete')
            await messages.updateOne(
              { _id: '101' },
              { $set: { 'reactionGenerations.50:0.complete': false } },
            );
          else if (reason === 'a live change was observed and settled during the page read')
            f.get.mockImplementation(async (route, options) => {
              if (route.endsWith('/messages'))
                state.dirty.settle('101', state.dirty.observe('101'));
              return get(route, options);
            });
          else if (reason === 'a Gateway gap occurred during the page read')
            f.get.mockImplementation(async (route, options) => {
              if (route.endsWith('/messages')) state.continuity.gapVersion += 1;
              return get(route, options);
            });
          else if (reason === 'the resumed run scans the source fully after its break settled') {
            state.continuity.breaks = [
              { index: state.continuity.breakIndex + 1, start: Date.now(), channelId: '10' },
            ];
            failHistory();
            await f.worker.periodic('1');
            expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
              status: 'partial',
              fullChannelIds: ['10'],
            });
            f.get.mockImplementation(get);
            state.continuity.breaks = [];
          }
          f.get.mockClear();
          await f.worker.periodic('1');
          const listReads = f.get.mock.calls.filter(([route]) => route.includes('/reactions/'));
          const after = await messages.findOne({ _id: '101' });
          if (outcome === 'kept') {
            expect(listReads).toHaveLength(0);
            expect(after?.reactionGenerations).toEqual(before?.reactionGenerations);
          } else if (outcome === 'reread') {
            expect(listReads.length).toBeGreaterThan(0);
            expect(after).not.toHaveProperty('reactionsStaleAt');
          } else {
            // Evidence a change may have invalidated is never trusted; the lists wait stale.
            expect(after?.reactionsStaleAt).toEqual(expect.any(Number));
            expect(after?.reactionGenerations).toEqual(before?.reactionGenerations);
          }
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it('keeps tombstones excluded when history returns an empty reaction list', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        await f.worker.periodic('1');
        const state = await f.worker.initialize('1');
        await state.repos.messages.tombstone('101', '10', Date.now());
        f.snapshot.reactions = [];
        await f.worker.periodic('1');
        const current = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(current?.deletedAt).toBeDefined();
        const channel = (await state.repos.channels.listChannels()).find(
          (item) => item.channelId === '10',
        );
        expect(channel?.checkpoints?.periodic).toMatchObject({
          complete: true,
          scanned: 1,
          admitted: 0,
        });
      } finally {
        await f.worker.stop();
      }
    }));

  it('records content changes separately in durable checkpoints', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        Object.assign(f.snapshot, { edited_timestamp: null });
        await f.worker.periodic('1');
        Object.assign(f.snapshot, {
          content: 'edited',
          edited_timestamp: new Date().toISOString(),
        });
        await f.worker.periodic('1');
        const state = await f.worker.initialize('1');
        expect(state.progress?.snapshot().messages).toMatchObject({
          updated: 1,
          inserted: 0,
          durable: 1,
        });
        const channel = (await state.repos.channels.listChannels()).find(
          (item) => item.channelId === '10',
        );
        expect(channel?.checkpoints?.periodic).toMatchObject({
          statistics: { messages: { updated: 1, inserted: 0 } },
        });
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        expect(stored).toMatchObject({ schemaVersion: 3, content: 'edited' });
        expect(stored?.editHistory).toHaveLength(1);
      } finally {
        await f.worker.stop();
      }
    }));

  it('writes a whole history page in one writer turn', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        const get = f.get.getMockImplementation()!;
        const page = Array.from({ length: 100 }, (_, index) => ({
          ...f.snapshot,
          id: String(1100 - index),
        }));
        f.get.mockImplementation(async (route, options) =>
          route.endsWith('/messages')
            ? options?.query?.get('before') === '1001'
              ? []
              : page
            : get(route, options),
        );
        const state = await f.worker.initialize('1');
        const load = vi.spyOn(state.repos.messages, 'loadSnapshotBatch');
        const persist = vi.spyOn(state.repos.messages, 'persistSnapshotsBatch');
        await f.worker.periodic('1');
        expect(load.mock.calls.map(([ids]) => ids.length)).toEqual([100]);
        expect(persist.mock.calls.map(([snapshots]) => snapshots.length)).toEqual([100]);
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(100);
      } finally {
        await f.worker.stop();
      }
    }));

  it('splits a page whose snapshots exceed the byte limit into bounded writer turns', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        const get = f.get.getMockImplementation()!;
        // Role IDs take a third more bytes in BSON than in JSON: the page fits the
        // fetch limit while its snapshots do not fit one writer turn.
        const roles = Array.from({ length: 1700 }, (_, index) =>
          String(100_000_000_000_000_000n + BigInt(index)),
        );
        const page = Array.from({ length: 100 }, (_, index) => ({
          ...f.snapshot,
          id: String(1100 - index),
          mention_roles: roles,
        }));
        f.get.mockImplementation(async (route, options) =>
          route.endsWith('/messages')
            ? options?.query?.get('before') === '1001'
              ? []
              : page
            : get(route, options),
        );
        const state = await f.worker.initialize('1');
        const persist = vi.spyOn(state.repos.messages, 'persistSnapshotsBatch');
        await f.worker.periodic('1');
        const turns = persist.mock.calls.map(([snapshots]) => snapshots);
        expect(turns.length).toBeGreaterThan(1);
        expect(turns.reduce((sum, turn) => sum + turn.length, 0)).toBe(100);
        for (const turn of turns)
          expect(
            turn.reduce((sum, snapshot) => sum + mongo.BSON.calculateObjectSize(snapshot), 0),
          ).toBeLessThanOrEqual(ARCHIVE_LIMITS.batchBytes);
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(100);
      } finally {
        await f.worker.stop();
      }
    }));

  it('halves the writer turn when stored image preload exceeds the byte budget', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        f.snapshot.reactions = [];
        const get = f.get.getMockImplementation()!;
        f.get.mockImplementation(async (route, options) =>
          route.endsWith('/messages')
            ? ['105', '104', '103', '102', '101'].map((id) => ({ ...f.snapshot, id }))
            : get(route, options),
        );
        const state = await f.worker.initialize('1');
        vi.spyOn(state.repos.messages, 'loadSnapshotBatch').mockRejectedValueOnce(
          new ArchiveLimitExceededError('Archive snapshot observations exceed byte limit'),
        );
        const persist = vi.spyOn(state.repos.messages, 'persistSnapshotsBatch');
        await f.worker.periodic('1');
        expect(persist.mock.calls.map(([snapshots]) => snapshots.length)).toEqual([3, 2]);
        expect(await connection.collection<StoredMessage>('messages').countDocuments()).toBe(5);
        const channel = (await state.repos.channels.listChannels()).find(
          (item) => item.channelId === '10',
        );
        expect(channel?.checkpoints?.periodic).toMatchObject({
          complete: true,
          scanned: 5,
          admitted: 5,
        });
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
          const previous = await connection
            .collection<StoredMessage>('messages')
            .findOne({ _id: '101' });
          f.snapshot.reactions = [];
          const persist = state.repos.messages.persistSnapshotsBatch.bind(state.repos.messages);
          vi.spyOn(state.repos.messages, 'persistSnapshotsBatch').mockImplementation(
            async (...args) => {
              queued();
              await blocked;
              return persist(...args);
            },
          );
          const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
          running = f.worker.periodic('1');
          await publicationQueued;
          expect(state.writer.snapshot().pending).toBe(1);
          // Prevent a later verification sweep from obtaining new evidence and repairing the race.
          f.get.mockRejectedValue(new Error('Source temporarily unavailable'));
          if (change === 'dirty') state.dirty.observe('101');
          else if (change === 'gap') state.continuity.gapVersion += 1;
          else state.work.preemptPeriodic();
          release();
          await running;
          expect(finalize).not.toHaveBeenCalled();
          const current = await connection
            .collection<StoredMessage>('messages')
            .findOne({ _id: '101' });
          expect(current?.reactionGenerations).toEqual(previous?.reactionGenerations);
          expect(current?.reactionsFreshAt).toEqual(previous?.reactionsFreshAt);
          const channel = (await state.repos.channels.listChannels()).find(
            (value) => value.channelId === '10',
          );
          expect(channel?.checkpoints?.periodic).toMatchObject({
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
        const persist = state.repos.messages.persistSnapshotsBatch.bind(state.repos.messages);
        vi.spyOn(state.repos.messages, 'persistSnapshotsBatch').mockImplementation(
          async (...args) => {
            if (change === 'dirty') state.dirty.observe('101');
            else state.continuity.gapVersion += 1;
            return persist(...args);
          },
        );
        const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
        try {
          await f.worker.periodic('1');
          expect(finalize).not.toHaveBeenCalled();
          const current = await connection
            .collection<StoredMessage>('messages')
            .findOne({ _id: '101' });
          expect(current?.reactionsFreshAt).toBeUndefined();
          const channel = (await state.repos.channels.listChannels()).find(
            (value) => value.channelId === '10',
          );
          expect(channel?.checkpoints?.periodic).toMatchObject({
            scanned: 0,
            pageSequence: 0,
            complete: false,
          });
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it.each([
    { evicted: 'target', publishes: false },
    { evicted: 'other', publishes: true },
  ] as const)(
    'scopes dirty-table eviction during a reaction fetch to affected readers ($evicted)',
    async ({ evicted, publishes }) =>
      withFreshConnection(async (connection) => {
        const f = fixture(new StaticConnectionManager(connection));
        const state = await f.worker.initialize('1');
        const capacity = archiveRuntimeSchema.parse({}).max_pending_events * 10;
        // Entries observed before the scan predate its reader.
        if (evicted === 'other')
          for (let i = 0; i < capacity; i += 1) state.dirty.observe(`old${i}`);
        const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
        // A full first normal page means the stream needs a second page.
        f.snapshot.reactions[0]!.count_details = { normal: 101, burst: 1 };
        f.snapshot.reactions[0]!.count = 102;
        const get = f.get.getMockImplementation()!;
        let flooded = false;
        let laterPages = 0;
        let afterFlood: { size: number; targetInTable: boolean } | undefined;
        f.get.mockImplementation(async (route, options) => {
          // Later fresh evidence could legitimately republish; keep only the flooded fetch.
          if (flooded && evicted === 'target' && !route.includes('/reactions/'))
            throw new Error('Source temporarily unavailable');
          if (route.includes('/reactions/') && options?.query?.get('after')) laterPages += 1;
          const firstNormalPage =
            route.includes('/reactions/') &&
            options?.query?.get('type') === '0' &&
            !options.query.get('after');
          if (!flooded && route.includes('/reactions/')) {
            flooded = true;
            if (evicted === 'target') {
              // The fetched message changes, then a flood evicts that change.
              state.dirty.observe('101');
              for (let i = 0; i < capacity; i += 1) state.dirty.observe(`flood${i}`);
            } else {
              for (let i = 0; i < 100; i += 1) state.dirty.observe(`flood${i}`);
            }
            // Recorded here; an assertion failing inside the mock would only fail the source.
            afterFlood = {
              size: state.dirty.size,
              targetInTable: state.dirty.versionOf('101') !== undefined,
            };
          }
          if (firstNormalPage)
            return Array.from({ length: 100 }, (_, index) => ({ id: String(2000 + index) }));
          if (route.includes('/reactions/') && options?.query?.get('after'))
            return [{ id: '3000' }];
          return get(route, options);
        });
        try {
          await f.worker.periodic('1');
          expect(flooded).toBe(true);
          // In the target case the flood evicted the fetched message's own change.
          expect(afterFlood).toEqual({ size: capacity, targetInTable: false });
          expect(finalize.mock.calls.some(([messageId]) => messageId === '101')).toBe(publishes);
          // An invalidated fetch stops instead of reading further pages.
          expect(laterPages > 0).toBe(publishes);
          // A message whose membership could not be confirmed stays stale; the page completes.
          const run = await connection.collection('archive_periodic_runs').findOne({});
          expect(run).toMatchObject({
            status: 'complete',
            progress: { reactions: { stale: publishes ? 0 : 1 } },
          });
          const stored = await connection
            .collection<StoredMessage>('messages')
            .findOne({ _id: '101' });
          expect(stored?.['reactionsStaleAt'] === undefined).toBe(publishes);
          expect(JSON.stringify(run?.['result'])).not.toContain('Gateway gap');
          expect(state.continuity.gapVersion).toBe(0);
        } finally {
          await f.worker.stop();
        }
      }),
  );

  it('keeps stale empty history evidence from publishing after a newer live event is settled', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      const state = await f.worker.initialize('1');
      // History returns an empty reaction list; the live source already has one reaction.
      f.snapshot.reactions = [];
      const live = {
        ...f.snapshot,
        reactions: [
          { emoji: { id: '50', name: 'first' }, count: 1, count_details: { normal: 1, burst: 0 } },
        ],
      };
      let pageRead = false;
      let injected = false;
      let inboxAfterDrain: number | undefined;
      let versionAfterDrain: number | undefined;
      f.get.mockImplementation(async (route: string, options?: { query?: URLSearchParams }) => {
        if (route === '/channels/10/messages') {
          // Only the first read is stale; a later sweep's fresh read is legitimate evidence.
          if (injected) throw new Error('Source temporarily unavailable');
          pageRead = true;
          return [f.snapshot];
        }
        if (route === '/channels/10/messages/101') return live;
        if (route.includes('/reactions/'))
          return options?.query?.get('type') === '0' ? [{ id: '1001' }] : [];
        return f.snapshot;
      });
      const finalize = vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh');
      try {
        // Between the history read and its write, a live reaction event is applied and
        // acknowledged. Its settled dirty entry must survive while the page holds evidence.
        await f.worker.periodic('1', async () => {
          if (pageRead && !injected) {
            injected = true;
            await f.worker.capture({
              eventId: 'live-reaction',
              guildId: '1',
              channelId: '10',
              messageId: '101',
              kind: 'reaction',
              observedAt: Date.now(),
            });
            await f.worker.drainInbox('1');
            // Recorded here; an assertion failing inside the hook would only pause the scan.
            inboxAfterDrain = await connection.collection('archive_inbox').countDocuments();
            versionAfterDrain = state.dirty.versionOf('101');
          }
          return true;
        });
        expect(injected).toBe(true);
        expect(inboxAfterDrain).toBe(0);
        expect(versionAfterDrain).toBeDefined();
        expect(
          finalize.mock.calls.some(
            ([messageId, , keys]) => messageId === '101' && keys.length === 0,
          ),
        ).toBe(false);
        const stored = await connection
          .collection<StoredMessage>('messages')
          .findOne({ _id: '101' });
        // The live event found no stored message to reconcile, so nothing was published.
        expect(Object.keys(stored?.reactionGenerations ?? {})).toEqual([]);
        // The stale evidence leaves the message marked stale without failing its page.
        expect(stored?.['reactionsStaleAt']).toBeTypeOf('number');
        expect(await connection.collection('archive_periodic_runs').findOne({})).toMatchObject({
          status: 'complete',
          progress: { reactions: { stale: 1 } },
        });
        // Once the page released its evidence, the settled entry left the table.
        expect(state.dirty.size).toBe(0);
        expect(state.dirty.held).toEqual({ reads: 0, pins: 0, settled: 0 });
      } finally {
        await f.worker.stop();
      }
    }));

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
      const finalize = state.repos.reactions.finalizeReactionRefresh.bind(state.repos.reactions);
      vi.spyOn(state.repos.reactions, 'finalizeReactionRefresh').mockImplementation(
        async (...args) => {
          observed.push(state.progress!.snapshot());
          return finalize(...args);
        },
      );
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

  it('keys custom emoji memberships by emoji ID per normal/burst stream, records the channel and survives renames', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection));
      try {
        await f.worker.periodic('1');
        let chunks = await connection
          .collection('archive_reactions')
          .find({ messageId: '101' })
          .toArray();
        expect(
          chunks.map((chunk) => [chunk.emojiKey, chunk.channelId, chunk.type, chunk.userIds]),
        ).toEqual(
          expect.arrayContaining([
            ['50', '10', 0, ['1001', '1002']],
            ['50', '10', 1, ['1003']],
          ]),
        );
        f.snapshot.reactions[0]!.emoji.name = 'renamed';
        await f.worker.periodic('1');
        chunks = await connection
          .collection('archive_reactions')
          .find({ messageId: '101' })
          .toArray();
        expect(new Set(chunks.map((chunk) => chunk.emojiKey))).toEqual(new Set(['50']));
        expect(chunks.every((chunk) => chunk.channelId === '10')).toBe(true);
      } finally {
        await f.worker.stop();
      }
    }));

  it('posts nothing to Discord for periodic passes and keeps their progress durable', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(new StaticConnectionManager(connection), true);
      try {
        await f.worker.periodic('1');
        expect(f.debugChannel.send).not.toHaveBeenCalled();
        expect(f.patch).not.toHaveBeenCalled();
        const saved = await connection
          .collection<{
            _id: string;
            progress: { messages: { durable: number } };
          }>('archive_periodic_runs')
          .findOne({ _id: 'current' });
        expect(saved?.progress.messages.durable).toBe(1);
      } finally {
        await f.worker.stop();
      }
    }));
});
