import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '../../../src/infra/archive/storage-usage';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { ArchiveGatewayDecoder } from '../../../src/plugins/message-backup/runtime/gateway-event';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import { withFreshConnection } from '../helpers/mongo';
import {
  buildArchiveWorker,
  freezeWallClock,
  stubArchiveInventory,
  type StoredMessage,
} from '../../helpers/archive-worker-fixture';

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

const author = { id: '1000', username: 'human', bot: false };
const THUMBS = { id: null, name: '👍' };
const PARTY = { id: '50', name: 'party' };
type Lists = Record<string, { normal: string[]; burst: string[] }>;

/**
 * A guild with one channel and message 101 reacted with 👍 (two normal users, one
 * burst) and :party: (one normal user). REST serves the current lists; tests change
 * them and send Gateway packets through the decoder.
 */
const fixture = (connection: Connection, inboxLoop = false) => {
  stubArchiveInventory();
  const lists: Lists = {
    '👍': { normal: ['2001', '2002'], burst: ['2003'] },
    'party:50': { normal: ['2004'], burst: [] },
  };
  const messages = new Map<string, Record<string, unknown>>();
  const emojiOf = (route: string) => (route === 'party:50' ? PARTY : THUMBS);
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    channel_id: '10',
    author,
    content: `message ${id}`,
    timestamp: '2026-01-01T00:00:00Z',
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    ...extra,
  });
  const current = (id: string) => ({
    ...(messages.get(id) ?? message(id)),
    ...(id === '101'
      ? {
          reactions: Object.entries(lists).map(([route, users]) => ({
            emoji: emojiOf(route),
            count: users.normal.length + users.burst.length,
            count_details: { normal: users.normal.length, burst: users.burst.length },
          })),
        }
      : {}),
  });
  const read = async (route: string, options?: { query?: URLSearchParams }) => {
    const reaction = /^\/channels\/10\/messages\/101\/reactions\/(.+)$/.exec(route);
    if (reaction !== null) {
      const users = lists[decodeURIComponent(reaction[1]!)] ?? { normal: [], burst: [] };
      const ids = options?.query?.get('type') === '1' ? users.burst : users.normal;
      return ids.map((id) => ({ id }));
    }
    if (route === '/channels/10/messages') return [current('101')];
    const single = /^\/channels\/10\/messages\/(\d+)$/.exec(route);
    if (single !== null) return current(single[1]!);
    throw new Error(`Unexpected route ${route}`);
  };
  const { worker, rest, logger } = buildArchiveWorker({
    connections: new StaticConnectionManager(connection),
    get: read,
    // A failed inbox loop round retries after 1 ms instead of a second.
    worker: { inboxLoop, inboxRetryBaseMs: 1 },
  });
  const get = rest.get;
  const decoder = new ArchiveGatewayDecoder('process');
  let sequence = 0;
  const packet = async (t: string, data: Record<string, unknown>): Promise<void> => {
    sequence += 1;
    for (const event of decoder.decode(
      { t, s: sequence, d: { guild_id: '1', channel_id: '10', ...data } },
      0,
      Date.now(),
    ))
      await worker.capture(event);
  };
  const stored = (id = '101') =>
    connection.collection<StoredMessage>('messages').findOne({ _id: id });
  /** Reaction list reads since the last `get.mockClear()`, as `<emoji>:<type>`. */
  const listReads = () =>
    get.mock.calls.flatMap(([route, options]) => {
      const match = /\/reactions\/(.+)$/.exec(route);
      return match === null
        ? []
        : [`${decodeURIComponent(match[1]!)}:${options?.query?.get('type')}`];
    });
  const messageReads = (id = '101') =>
    get.mock.calls.filter(([route]) => route === `/channels/10/messages/${id}`).length;
  return { worker, get, lists, messages, message, packet, stored, listReads, messageReads, logger };
};
type Fixture = ReturnType<typeof fixture>;

/** Message 101 archived with complete lists by a first (full) periodic pass. */
const archived = async (f: Fixture) => {
  await f.worker.periodic('1');
  const before = await f.stored();
  expect(Object.keys(before?.reactionGenerations ?? {}).sort()).toEqual([
    '50:0',
    '50:1',
    '👍:0',
    '👍:1',
  ]);
  f.get.mockClear();
  return before!;
};

describe('msg-archive live reconciliation', () => {
  it('stores a complete MESSAGE_CREATE without a REST read, with an empty list as of creation', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await f.worker.initialize('1');
        await f.packet('MESSAGE_CREATE', f.message('102'));
        await f.worker.drainInbox('1');
        expect(f.messageReads('102')).toBe(0);
        const created = await f.stored('102');
        expect(created).toMatchObject({ content: 'message 102', reactionGenerations: {} });
        expect(created?.reactionsFreshAt).toEqual(expect.any(Number));
        expect(created).not.toHaveProperty('reactionsStaleAt');
        // A creation without its author still needs the REST read to classify it.
        await f.packet('MESSAGE_CREATE', { ...f.message('103'), author: undefined });
        await f.worker.drainInbox('1');
        expect(f.messageReads('103')).toBe(1);
      } finally {
        await f.worker.stop();
      }
    }));

  it('rereads only the list a reaction event names and keeps the others', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        const before = await archived(f);
        f.lists['👍']!.normal.push('2005');
        await f.packet('MESSAGE_REACTION_ADD', {
          message_id: '101',
          user_id: '2005',
          emoji: THUMBS,
          burst: false,
          type: 0,
        });
        await f.worker.drainInbox('1');
        expect(f.messageReads()).toBe(1);
        expect(f.listReads()).toEqual(['👍:0']);
        const after = await f.stored();
        expect(after?.reactionGenerations?.['👍:0']?.generation).not.toBe(
          before.reactionGenerations['👍:0'].generation,
        );
        for (const key of ['👍:1', '50:0', '50:1'])
          expect(after?.reactionGenerations?.[key]).toEqual(before.reactionGenerations[key]);
        expect(after).not.toHaveProperty('reactionsStaleAt');
        // Freshness belongs to complete refreshes.
        expect(after?.reactionsFreshAt).toBe(before.reactionsFreshAt);
        const chunks = await connection
          .collection('archive_reactions')
          .find({ messageId: '101', generation: after?.reactionGenerations?.['👍:0']?.generation })
          .toArray();
        expect(chunks.flatMap((chunk) => chunk['userIds'])).toEqual(['2001', '2002', '2005']);
      } finally {
        await f.worker.stop();
      }
    }));

  it.each([
    ['the lists are already marked stale', 'stale'],
    ['two reactions changed before the event was reduced', 'batch'],
    ['the counts of another reaction changed', 'counts'],
    ['the event does not name its emoji', 'unnamed'],
  ] as const)('rereads every list when %s', async (_label, cause) =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await archived(f);
        const state = await f.worker.initialize('1');
        if (cause === 'stale') await state.repos.reactions.markReactionsStale('101', Date.now());
        if (cause === 'counts') f.lists['party:50']!.normal.push('2006');
        if (cause === 'batch') {
          f.lists['party:50']!.normal.push('2006');
          await f.packet('MESSAGE_REACTION_ADD', { message_id: '101', emoji: PARTY, type: 0 });
        }
        f.lists['👍']!.normal.push('2005');
        await f.packet('MESSAGE_REACTION_ADD', {
          message_id: '101',
          ...(cause === 'unnamed' ? {} : { emoji: THUMBS }),
          type: 0,
        });
        await f.worker.drainInbox('1');
        expect(f.listReads().sort()).toEqual(['party:50:0', '👍:0', '👍:1']);
        expect(await f.stored()).not.toHaveProperty('reactionsStaleAt');
      } finally {
        await f.worker.stop();
      }
    }),
  );

  it('rereads no list for a poll vote or an edit, and drops the lists of a removed emoji', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        const before = await archived(f);
        await f.packet('MESSAGE_POLL_VOTE_ADD', {
          message_id: '101',
          user_id: '2007',
          answer_id: 1,
        });
        f.messages.set(
          '101',
          f.message('101', { content: 'edited', edited_timestamp: new Date().toISOString() }),
        );
        await f.packet('MESSAGE_UPDATE', { ...f.message('101'), content: 'edited' });
        await f.worker.drainInbox('1');
        expect(f.listReads()).toEqual([]);
        const edited = await f.stored();
        expect(edited).toMatchObject({ content: 'edited' });
        expect(edited).not.toHaveProperty('reactionsStaleAt');
        expect(edited?.reactionGenerations).toEqual(before.reactionGenerations);
        delete f.lists['party:50'];
        await f.packet('MESSAGE_REACTION_REMOVE_EMOJI', { message_id: '101', emoji: PARTY });
        await f.worker.drainInbox('1');
        expect(f.listReads()).toEqual([]);
        const removed = await f.stored();
        expect(Object.keys(removed?.reactionGenerations ?? {}).sort()).toEqual(['👍:0', '👍:1']);
        expect(removed).not.toHaveProperty('reactionsStaleAt');
      } finally {
        await f.worker.stop();
      }
    }));
});

describe('msg-archive live reconciliation safeguards', () => {
  it.each([
    ['the other type has no complete list', 'type', ['👍:0', '👍:1']],
    ['the lists have no recorded freshness', 'freshness', ['party:50:0', '👍:0', '👍:1']],
    [
      'the lists were refreshed before the lossless window began',
      'window',
      ['party:50:0', '👍:0', '👍:1'],
    ],
  ] as const)('widens a reaction event refresh when %s', async (_label, cause, reads) =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        await archived(f);
        const state = await f.worker.initialize('1');
        const messages = connection.collection<StoredMessage>('messages');
        if (cause === 'type')
          await messages.updateOne({ _id: '101' }, { $unset: { 'reactionGenerations.👍:1': 1 } });
        if (cause === 'freshness')
          await messages.updateOne({ _id: '101' }, { $unset: { reactionsFreshAt: 1 } });
        if (cause === 'window') state.continuity.continuousSince = Date.now();
        f.lists['👍']!.normal.push('2005');
        await f.packet('MESSAGE_REACTION_ADD', { message_id: '101', emoji: THUMBS, type: 0 });
        await f.worker.drainInbox('1');
        expect(f.listReads().sort()).toEqual([...reads]);
        expect(await f.stored()).not.toHaveProperty('reactionsStaleAt');
      } finally {
        await f.worker.stop();
      }
    }),
  );

  it('admits message reads and list reads per route and channel', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      const run = vi.spyOn(ArchiveScheduler.prototype, 'run');
      try {
        await archived(f);
        f.lists['👍']!.normal.push('2005');
        await f.packet('MESSAGE_REACTION_ADD', { message_id: '101', emoji: THUMBS, type: 0 });
        await f.worker.drainInbox('1');
        const resources = run.mock.calls.map(([key, , , options]) => [
          key.split(':')[0],
          options?.resource,
        ]);
        expect(resources).toContainEqual(['live', { route: 'message', channelId: '10' }]);
        expect(resources).toContainEqual(['reaction', { route: 'reactions', channelId: '10' }]);
      } finally {
        run.mockRestore();
        await f.worker.stop();
      }
    }));

  it('lets a reaction that overtook a deferred creation wait, then reads the message whole', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      const inbox = connection.collection('archive_inbox');
      try {
        await f.worker.initialize('1');
        await f.packet('MESSAGE_CREATE', f.message('101'));
        const now = freezeWallClock();
        // The creation failed once and waits for its retry.
        await inbox.updateOne({ kind: 'snapshot' }, { $set: { nextAttemptAt: now + 60_000 } });
        await f.packet('MESSAGE_REACTION_ADD', { message_id: '101', emoji: THUMBS, type: 0 });
        await f.worker.drainInbox('1');
        const waiting = await inbox.findOne({ kind: 'reaction' });
        expect(waiting).toMatchObject({ state: 'pending', attempts: 0 });
        // The reaction waits exactly as long as the creation it overtook.
        expect(waiting?.['nextAttemptAt']).toBe(now + 60_000);
        expect(await f.stored()).toBeNull();
        await inbox.updateMany({}, { $unset: { nextAttemptAt: 1 } });
        await f.worker.drainInbox('1');
        expect(await inbox.countDocuments()).toBe(0);
        // The creation does not claim an empty list; the lists are read whole.
        const stored = await f.stored();
        expect(Object.keys(stored?.reactionGenerations ?? {}).sort()).toEqual([
          '50:0',
          '50:1',
          '👍:0',
          '👍:1',
        ]);
        expect(stored).not.toHaveProperty('reactionsStaleAt');
      } finally {
        await f.worker.stop();
      }
    }));

  it('moves the lossless window forward for an unseeded session without planning a rescan', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection);
      try {
        const state = await f.worker.initialize('1');
        const breaks = state.continuity.breaks.length;
        const observedAt = Date.now() + 1000;
        await f.worker.capture({
          eventId: 'unseeded',
          guildId: '1',
          observedAt,
          kind: 'session',
          unseeded: true,
        });
        expect(state.continuity.continuousSince).toBe(observedAt);
        expect(state.continuity.breaks).toHaveLength(breaks);
      } finally {
        await f.worker.stop();
      }
    }));
});

describe('msg-archive inbox loop', () => {
  it('reduces captured events without being asked', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection, true);
      try {
        await f.worker.initialize('1');
        await f.packet('MESSAGE_CREATE', f.message('102'));
        await vi.waitFor(async () => expect(await f.stored('102')).not.toBeNull());
        await vi.waitFor(async () =>
          expect(await connection.collection('archive_inbox').countDocuments()).toBe(0),
        );
      } finally {
        await f.worker.stop();
      }
    }));

  it('lets history pages proceed while a live reconciliation waits on Discord', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection, true);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const page = Array.from({ length: 100 }, (_, index) => f.message(String(1100 - index)));
      const get = f.get.getMockImplementation()!;
      let captured = false;
      f.get.mockImplementation(async (route, options) => {
        if (route === '/channels/10/messages/102') await blocked;
        if (route !== '/channels/10/messages') return get(route, options);
        if (!captured) {
          // A live event arrives once the scan is underway; its read stays blocked.
          captured = true;
          await f.packet('MESSAGE_UPDATE', f.message('102'));
          await vi.waitFor(() => expect(f.messageReads('102')).toBe(1));
        }
        return options?.query?.get('before') === '1001' ? [] : page;
      });
      let passing: Promise<void> | undefined;
      try {
        await f.worker.initialize('1');
        passing = f.worker.periodic('1');
        // Both pages finish while the live read is still blocked.
        await vi.waitFor(async () =>
          expect(
            (await connection.collection('archive_channels').findOne({ channelId: '10' }))?.[
              'checkpoints'
            ]?.['periodic'],
          ).toMatchObject({ complete: true, scanned: 100 }),
        );
        expect(f.messageReads('102')).toBe(1);
        release();
        await passing;
        expect(await f.stored('102')).toMatchObject({ content: 'message 102' });
      } finally {
        release();
        await passing;
        await f.worker.stop();
      }
    }));

  it('logs a failed round and retries it', async () =>
    withFreshConnection(async (connection) => {
      const f = fixture(connection, true);
      const warn = vi.spyOn(f.logger, 'warn');
      try {
        const state = await f.worker.initialize('1');
        const claim = state.repos.inbox.claimInboxBatch.bind(state.repos.inbox);
        vi.spyOn(state.repos.inbox, 'claimInboxBatch')
          .mockRejectedValueOnce(new Error('database unavailable'))
          .mockImplementation(claim);
        await f.packet('MESSAGE_CREATE', f.message('102'));
        await vi.waitFor(async () => expect(await f.stored('102')).not.toBeNull(), {
          timeout: 5000,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ failures: 1 }),
          'Archive inbox round failed; retrying',
        );
      } finally {
        await f.worker.stop();
      }
    }));
});
