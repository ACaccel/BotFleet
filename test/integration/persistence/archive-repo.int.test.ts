import { mongo } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { ARCHIVE_LIMITS } from '../../../src/core/archive/limits';
import { ArchiveLimitExceededError } from '../../../src/core/archive/errors';
import { normalizeMessage } from '../../../src/core/archive/normalize';
import { ARCHIVE_EDIT_HISTORY_LIMIT, type ArchiveMessage } from '../../../src/core/archive/types';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoArchiveRepo,
  type ArchiveMutationInterceptor,
} from '../../../src/persistence/repositories/archive.repo';
import {
  ArchiveInboxInvalidError,
  ArchiveInboxOversizedError,
  isArchiveInboxUnclaimable,
  MongoArchiveInboxRepo,
} from '../../../src/persistence/repositories/archive-inbox.repo';
import { MongoArchiveChannelRepo } from '../../../src/persistence/repositories/archive-channel.repo';
import { MongoArchiveJobRepo } from '../../../src/persistence/repositories/archive-job.repo';
import { MongoArchiveOwnerRepo } from '../../../src/persistence/repositories/archive-owner.repo';
import { MongoArchiveReactionRepo } from '../../../src/persistence/repositories/archive-reaction.repo';
import { buildArchiveWriterRepos } from '../../../src/persistence/repositories/archive-repos';
import { buildRepos } from '../../../src/persistence/repositories';
import { withFreshConnection } from '../helpers/mongo';
const guildId = asGuildId('1');
const created = Date.parse('2023-11-14T22:13:20.000Z');
const raw = (content: string, edited: number | null, extra: Record<string, unknown> = {}) => ({
  id: '3',
  channel_id: '2',
  author: { id: '4', username: 'Alice' },
  content,
  timestamp: new Date(created).toISOString(),
  edited_timestamp: edited === null ? null : new Date(edited).toISOString(),
  attachments: [],
  embeds: [],
  reactions: [],
  ...extra,
});
/** A REST observation of message 3, edited at `edited` (`created`: the original version). */
const snapshot = (content: string, edited = created, observedAt = edited) =>
  normalizeMessage(raw(content, edited === created ? null : edited), { observedAt });
type Db = Parameters<Parameters<typeof withFreshConnection>[0]>[0];
const messages = (connection: Db) =>
  connection.collection<ArchiveMessage & Record<string, unknown>>('messages');
const stored = (connection: Db, id = '3') => messages(connection).findOne({ _id: id });
const openRepo = async (connection: Db) => {
  const conn = await new StaticConnectionManager(connection).getConnection(guildId);
  const repos = buildArchiveWriterRepos(conn);
  return {
    conn,
    repo: repos.messages,
    inboxRepo: repos.inbox,
    reactionRepo: repos.reactions,
    channelRepo: repos.channels,
    jobRepo: repos.jobs,
    ownerRepo: repos.owner,
  };
};
/** One staged membership chunk of message 3 in channel 2. */
const chunk = (
  emojiKey: string,
  generation: string,
  userIds: string[],
  observedAt: number,
  index = 0,
  messageId = '3',
) => ({
  messageId,
  channelId: '2',
  emojiKey,
  type: 0 as const,
  generation,
  chunk: index,
  userIds,
  observedAt,
});
/** A reaction inbox event for message 3 in channel 2. */
const reactionEvent = (eventId: string, observedAt: number) => ({
  eventId,
  kind: 'reaction' as const,
  messageId: '3',
  channelId: '2',
  payload: {},
  observedAt,
});
describe('Mongo archive durability', () => {
  it('bulk-writes independent snapshots keyed by message ID and verifies images', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const collection = connection.collection('messages');
      const bulk = vi.spyOn(collection, 'bulkWrite');
      const originalCollection = connection.collection.bind(connection);
      vi.spyOn(connection, 'collection').mockImplementation((name, options) =>
        name === 'messages' ? collection : originalCollection(name, options),
      );
      expect(
        await repo.persistSnapshotsBatch([snapshot('A'), { ...snapshot('B'), _id: '5' }]),
      ).toEqual(['inserted', 'inserted']);
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(bulk.mock.calls[0]?.[0]).toHaveLength(2);
      expect((await collection.find({}).sort({ _id: 1 }).toArray()).map((doc) => doc._id)).toEqual([
        '3',
        '5',
      ]);
      expect(await stored(connection)).toMatchObject({ schemaVersion: 3, channelId: '2' });
    });
  });

  it('rejects an after-image changed between bulk persistence and verification', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const collection = connection.collection<{ _id: string }>('messages');
      const originalBulk = collection.bulkWrite.bind(collection);
      vi.spyOn(collection, 'bulkWrite').mockImplementation(async (operations, options) => {
        const result = await originalBulk(operations, options);
        await collection.updateOne({ _id: '3' }, { $set: { content: 'external' } });
        return result;
      });
      const originalCollection = connection.collection.bind(connection);
      vi.spyOn(connection, 'collection').mockImplementation((name, options) =>
        name === 'messages' ? (collection as never) : originalCollection(name, options),
      );
      await expect(repo.persistSnapshotsBatch([snapshot('A')])).rejects.toThrow(
        'Archive batch verification failed',
      );
    });
  });

  it('rejects stale bulk before-images without replacing external changes', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('A'));
      const observed = (await repo.loadSnapshotBatch(['3'])).get('3')!;
      await messages(connection).updateOne({ _id: '3' }, { $set: { content: 'external' } });
      await expect(
        repo.persistSnapshotsBatch([snapshot('B', created + 1000)], {
          snapshotContexts: [{ observed }],
        }),
      ).rejects.toThrow('Archive write conflict');
      expect((await stored(connection))?.content).toBe('external');
    });
  });

  it('rechecks reaction evidence before publishing the message', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('A'));
      let checks = 0;
      await expect(
        repo.persistSnapshotsBatch([snapshot('B', created + 1000)], {
          snapshotContexts: [
            {
              emptyReactions: {
                observedAt: created + 1000,
                assertCurrent: () => {
                  if (++checks === 3) throw new Error('Reaction changed during refresh');
                },
              },
            },
          ],
        }),
      ).rejects.toThrow('Reaction changed during refresh');
      expect((await stored(connection))?.content).toBe('A');
    });
  });

  it('reports content changes separately from freshness-only rewrites', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const first = snapshot('A');
      expect(await repo.persistSnapshot(first)).toBe('inserted');
      expect(await repo.persistSnapshot({ ...first, observedAt: first.observedAt + 1 })).toBe(
        'unchanged',
      );
      expect((await stored(connection))?.observedAt).toBe(first.observedAt + 1);
      expect(await repo.persistSnapshot(snapshot('B', created + 1000))).toBe('updated');
    });
  });

  it('merges proven empty reactions into the snapshot and removes stale generation pointers', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const first = snapshot('A');
      await repo.persistSnapshot(first);
      await messages(connection).updateOne(
        { _id: '3' },
        {
          $set: {
            reactionGenerations: { 'old:0': { generation: 'old', observedAt: 1, complete: true } },
            reactionsStaleAt: first.observedAt,
          },
        },
      );
      const assertCurrent = vi.fn();
      await repo.persistSnapshotsBatch([{ ...first, observedAt: first.observedAt + 10 }], {
        snapshotContexts: [
          { emptyReactions: { observedAt: first.observedAt + 10, assertCurrent } },
        ],
      });
      const after = await stored(connection);
      expect(after?.reactionGenerations).toEqual({});
      expect(after?.reactionsFreshAt).toBe(first.observedAt + 10);
      expect(after).not.toHaveProperty('reactionsStaleAt');
      expect(assertCurrent).toHaveBeenCalledTimes(4);
    });
  });

  it('raises only the freshness of an unchanged re-observation, fenced on the full image', async () => {
    await withFreshConnection(async (connection) => {
      const { repo, reactionRepo } = await openRepo(connection);
      const collection = connection.collection('messages');
      const originalCollection = connection.collection.bind(connection);
      vi.spyOn(connection, 'collection').mockImplementation((name, options) =>
        name === 'messages' ? collection : originalCollection(name, options),
      );
      const first = snapshot('A');
      await repo.persistSnapshot(first);
      const before = await stored(connection);
      const replace = vi.spyOn(collection, 'replaceOne');
      const update = vi.spyOn(collection, 'updateOne');
      const bulk = vi.spyOn(collection, 'bulkWrite');
      expect(await repo.persistSnapshot({ ...first, observedAt: first.observedAt + 10 })).toBe(
        'unchanged',
      );
      expect(update).toHaveBeenCalledWith(expect.anything(), {
        $set: { observedAt: first.observedAt + 10 },
      });
      const after = await stored(connection);
      expect(after).toEqual({ ...before, observedAt: first.observedAt + 10 });
      expect(Object.keys(after!)).toEqual(Object.keys(before!));
      expect(
        await repo.persistSnapshotsBatch([{ ...first, observedAt: first.observedAt + 20 }]),
      ).toEqual(['unchanged']);
      expect(bulk.mock.calls[0]?.[0]).toEqual([
        {
          updateOne: expect.objectContaining({
            update: { $set: { observedAt: first.observedAt + 20 } },
          }),
        },
      ]);
      expect(replace).not.toHaveBeenCalled();
      // A stale read of the document fails the update instead of raising its freshness.
      const observed = await stored(connection);
      await messages(connection).updateOne({ _id: '3' }, { $set: { content: 'elsewhere' } });
      await expect(
        repo.persistSnapshot({ ...first, observedAt: first.observedAt + 30 }, { observed }),
      ).rejects.toThrow('Archive write conflict');
      expect((await stored(connection))?.observedAt).toBe(first.observedAt + 20);
      // Content changes, with or without an edit, and added fields are still replacements.
      expect(
        await repo.persistSnapshot({
          ...first,
          observedAt: first.observedAt + 40,
          embeds: [{ title: 'link preview' }],
        }),
      ).toBe('updated');
      expect(replace).toHaveBeenCalledTimes(1);
      await repo.persistSnapshot(snapshot('B', created + 1000));
      expect(replace).toHaveBeenCalledTimes(2);
      await reactionRepo.markReactionsStale('3', created + 2000);
      expect(replace).toHaveBeenCalledTimes(3);
      // The freshness update, the external edit and the rejected fenced update.
      expect(update).toHaveBeenCalledTimes(3);
    });
  });

  it('fences cancellation and invalid empty evidence before any snapshot batch is issued', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo } = await openRepo(connection);
      const cancelled = () => {
        throw new Error('cancelled');
      };
      await expect(
        repo.persistSnapshotsBatch([snapshot('A')], { beforeWrite: cancelled }),
      ).rejects.toThrow('cancelled');
      await expect(
        repo.persistSnapshotsBatch([snapshot('A')], {
          snapshotContexts: [{ emptyReactions: { observedAt: created, assertCurrent: cancelled } }],
        }),
      ).rejects.toThrow('cancelled');
      expect(await conn.models.Message.countDocuments()).toBe(0);
    });
  });

  it('preserves intercepted insert image bytes when MongoDB places the identity first', async () => {
    await withFreshConnection(async (connection) => {
      const { repo, channelRepo } = await openRepo(connection);
      const persisted: string[] = [];
      const interceptor: ArchiveMutationInterceptor = async (collection, before, after) => {
        expect(before).toBeNull();
        if (after === null) throw new Error('Expected a new archive record');
        const target = connection.collection<Record<string, unknown>>(collection);
        await target.insertOne(after);
        const found = await target.findOne({});
        expect(found).not.toBeNull();
        expect(mongo.BSON.serialize(found!)).toEqual(mongo.BSON.serialize(after));
        persisted.push(collection);
      };
      await channelRepo.upsertChannel(
        { channelId: '2', name: 'general', type: 0, observedAt: created, access: 'readable' },
        { interceptor },
      );
      await repo.persistSnapshot(snapshot('first'), { interceptor });
      expect(persisted).toEqual(['archive_channels', 'messages']);
    });
  });

  it('batch-loads observations once and applies successive versions of the same identity', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const loading = vi.spyOn(repo, 'loadSnapshotBatch');
      const outcomes = await repo.persistSnapshotsBatch([
        snapshot('A'),
        snapshot('B', created + 1000),
        snapshot('A', created + 2000),
      ]);
      expect(loading).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(['inserted', 'updated', 'updated']);
      const after = await stored(connection);
      expect(after?.content).toBe('A');
      expect(after?.editHistory?.map((entry) => entry.content)).toEqual(['A', 'B']);
    });
  });

  it('skips identical durable images while persisting newer freshness metadata', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo } = await openRepo(connection);
      const first = snapshot('same');
      await repo.persistSnapshot(first);
      const replacing = vi.spyOn(conn.connection.collection('messages'), 'replaceOne');
      const updating = vi.spyOn(conn.connection.collection('messages'), 'updateOne');
      expect(await repo.persistSnapshot(first)).toBe('unchanged');
      expect(replacing).not.toHaveBeenCalled();
      expect(updating).not.toHaveBeenCalled();
      expect(await repo.persistSnapshot({ ...first, observedAt: first.observedAt + 1000 })).toBe(
        'unchanged',
      );
      expect(replacing).not.toHaveBeenCalled();
      expect(updating).toHaveBeenCalledTimes(1);
      expect((await stored(connection))?.observedAt).toBe(first.observedAt + 1000);
    });
  });

  it('fences cached no-op observations against an external modification', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      const first = snapshot('same');
      await repo.persistSnapshot(first);
      const cached = await repo.loadSnapshotBatch(['3']);
      await messages(connection).updateOne({ _id: '3' }, { $set: { content: 'external' } });
      await expect(repo.persistSnapshot(first, { observed: cached.get('3')! })).rejects.toThrow(
        'Archive write conflict',
      );
      expect((await stored(connection))?.content).toBe('external');
    });
  });

  it('records each real edit once, in the same write as the new content', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('first'));
      const collection = conn.connection.collection('messages');
      const originalReplace = collection.replaceOne.bind(collection);
      const crash = vi.spyOn(collection, 'replaceOne').mockImplementationOnce(async () => {
        throw new Error('crash during write');
      });
      await expect(repo.persistSnapshot(snapshot('second', created + 1000))).rejects.toThrow(
        'crash',
      );
      // Neither the edit nor its history entry was written.
      expect((await stored(connection))?.editHistory).toBeUndefined();
      crash.mockImplementation(originalReplace);
      await repo.persistSnapshot(snapshot('second', created + 1000));
      await repo.persistSnapshot(snapshot('third', created + 2000));
      // A replayed or older observation is stale and changes nothing.
      expect(await repo.persistSnapshot(snapshot('second', created + 1000))).toBe('stale');
      expect(await repo.persistSnapshot(snapshot('third', created + 2000, created))).toBe('stale');
      const after = await stored(connection);
      expect(after?.content).toBe('third');
      expect(after?.editHistory).toEqual([
        {
          editedTimestamp: null,
          observedAt: created,
          content: 'first',
          attachments: [],
          embeds: [],
        },
        {
          editedTimestamp: created + 1000,
          observedAt: created + 1000,
          content: 'second',
          attachments: [],
          embeds: [],
        },
      ]);
      await repo.tombstone('3', '2', created + 3000);
      await repo.persistSnapshot(snapshot('third', created + 2000, created + 4000));
      expect((await stored(connection))?.deletedAt).toBe(created + 3000);
    });
  });

  it('does not record link previews, poll votes or reaction counts as edits', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(
        normalizeMessage(
          raw('poll', null, { poll: { question: { text: 'Q' }, answers: [{ answer_id: 1 }] } }),
          { observedAt: created },
        ),
      );
      const preview = [{ type: 'link', url: 'https://example.com' }];
      const later = (observedAt: number, extra: Record<string, unknown>) =>
        normalizeMessage(raw('poll', null, { embeds: preview, ...extra }), { observedAt });
      await repo.persistSnapshot(later(created + 1, {}));
      await repo.persistSnapshot(
        later(created + 2, {
          poll: {
            question: { text: 'Q' },
            answers: [{ answer_id: 1 }],
            results: { answer_counts: [{ id: 1, count: 5 }] },
          },
        }),
      );
      await repo.persistSnapshot(
        later(created + 3, { reactions: [{ emoji: { name: '👍' }, count: 2 }] }),
      );
      const after = await stored(connection);
      expect(after?.editHistory).toBeUndefined();
      expect(after?.embeds).toEqual(preview);
      expect(after?.poll?.answers?.[0]?.voteCount).toBe(5);
      expect(after?.reactions).toEqual([{ emoji: { name: '👍' }, count: 2 }]);
    });
  });

  it('keeps the newest edit history and counts what it drops', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('v0'));
      const edits = ARCHIVE_EDIT_HISTORY_LIMIT + 3;
      for (let version = 1; version <= edits; version += 1)
        await repo.persistSnapshot(snapshot(`v${version}`, created + version * 1000));
      const after = await stored(connection);
      expect(after?.content).toBe(`v${edits}`);
      expect(after?.editHistory).toHaveLength(ARCHIVE_EDIT_HISTORY_LIMIT);
      expect(after?.editHistoryDropped).toBe(3);
      expect(after?.editHistory?.[0]?.content).toBe('v3');
    });
  });

  it('merges partial live updates without clearing unobserved fields', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(
        normalizeMessage(
          raw('A', null, { embeds: [{ title: 'notice' }], attachments: [{ id: '9' }] }),
          {
            observedAt: 10,
          },
        ),
      );
      // A Gateway update that carries only the changed content and its edit time.
      await repo.persistSnapshot(
        normalizeMessage(
          {
            id: '3',
            channel_id: '2',
            content: 'B',
            edited_timestamp: new Date(created + 5000).toISOString(),
          },
          { observedAt: 20 },
        ),
      );
      const after = await stored(connection);
      expect(after).toMatchObject({
        content: 'B',
        embeds: [{ title: 'notice' }],
        attachments: [{ id: '9' }],
        author: { id: '4', username: 'Alice' },
        editedTimestamp: created + 5000,
      });
      expect(after?.editHistory?.map((entry) => entry.content)).toEqual(['A']);
      // A partial update without an edit time only fills the fields it carries.
      await repo.persistSnapshot(
        normalizeMessage({ id: '3', channel_id: '2', embeds: [] }, { observedAt: 30 }),
      );
      expect(await stored(connection)).toMatchObject({ content: 'B', embeds: [] });
      expect((await stored(connection))?.editHistory).toHaveLength(1);
    });
  });

  it('never lets an older observation overwrite newer content', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('new', created + 5000, 100));
      // Read before the edit, written after it.
      expect(await repo.persistSnapshot(snapshot('old', created, 200))).toBe('stale');
      // Same version, older observation.
      expect(
        await repo.persistSnapshot(
          normalizeMessage(raw('new', created + 5000, { embeds: [{ title: 'x' }] }), {
            observedAt: 50,
          }),
        ),
      ).toBe('stale');
      const after = await stored(connection);
      expect(after).toMatchObject({ content: 'new', embeds: [], observedAt: 100 });
      expect(after?.editHistory).toBeUndefined();
    });
  });

  it('fills a tombstone from an older observation without undeleting it', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      // A snowflake created at `created`, as Discord assigns them.
      const id = (BigInt(created - 1420070400000) << 22n).toString();
      const observed = (content: string, observedAt: number) =>
        normalizeMessage({ ...raw(content, null), id }, { observedAt });
      await repo.tombstone(id, '2', created + 5000);
      // The create was read before the deletion but applied after it.
      expect(await repo.persistSnapshot(observed('hello', created + 1000))).toBe('filled');
      expect(await stored(connection, id)).toMatchObject({
        content: 'hello',
        author: { id: '4', username: 'Alice' },
        deletedAt: created + 5000,
        observedAt: created + 5000,
      });
      expect((await stored(connection, id))?.editHistory).toBeUndefined();
      // Nothing is left to fill, and nothing is replaced.
      expect(await repo.persistSnapshot(observed('older', created + 500))).toBe('stale');
      expect((await stored(connection, id))?.content).toBe('hello');
    });
  });

  it('discards only messages kept until their author was known, fenced on the observed image', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo } = await openRepo(connection);
      const unresolved = {
        ...normalizeMessage({ id: '7', channel_id: '2' }, { observedAt: 1 }),
        policy: { version: '1', reason: 'unknown-author-retained' },
      };
      await repo.persistSnapshot(unresolved);
      await repo.persistSnapshot(snapshot('human'));
      expect(await repo.discardUnresolved((await stored(connection))!)).toBe(false);
      const observed = (await stored(connection, '7'))!;
      await messages(connection).updateOne({ _id: '7' }, { $set: { content: 'concurrent' } });
      await expect(repo.discardUnresolved(observed)).rejects.toThrow('Archive write conflict');
      expect(await repo.discardUnresolved((await stored(connection, '7'))!)).toBe(true);
      expect(await stored(connection, '7')).toBeNull();
      expect(await conn.models.Message.countDocuments()).toBe(1);
    });
  });

  it('tombstones an unseen deletion with only identity and deletion metadata', async () => {
    await withFreshConnection(async (connection) => {
      const { repo } = await openRepo(connection);
      await repo.tombstone('1180000000000000000', '2', 50);
      await repo.tombstone('1180000000000000000', '2', 40);
      expect(await stored(connection, '1180000000000000000')).toEqual({
        _id: '1180000000000000000',
        schemaVersion: 3,
        channelId: '2',
        createdTimestamp: Number(BigInt('1180000000000000000') >> 22n) + 1420070400000,
        observedAt: 50,
        deletedAt: 40,
      });
    });
  });

  it('renews bounded inbox claims, tolerates acknowledged members and rejects foreign leases', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      for (const eventId of ['a', 'b', 'c']) await inboxRepo.enqueue(reactionEvent(eventId, 1));
      expect(
        (await inboxRepo.claimInboxBatch('owner', 10, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['a', 'b']);
      await inboxRepo.ackInbox('a', 'owner');
      await inboxRepo.renewInboxBatch('owner', ['a', 'b'], 50, 100);
      expect(
        (await inboxRepo.claimInboxBatch('other', 110, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['c']);
      await expect(inboxRepo.renewInboxBatch('other', ['b'], 120, 100)).rejects.toThrow(
        'claim lost',
      );
      expect(
        (await inboxRepo.claimInboxBatch('other', 150, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['b']);
      await expect(inboxRepo.ackInbox('b', 'owner')).rejects.toThrow('claim lost');
    });
  });

  it('bounds empty polling and invalidates the cache as soon as a local event is enqueued', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      const finding = vi.spyOn(conn.models.ArchiveInbox.collection, 'find');
      expect(await inboxRepo.claimInboxBatch('owner', 10, 100)).toEqual([]);
      expect(await inboxRepo.claimInboxBatch('owner', 100, 100)).toEqual([]);
      expect(await inboxRepo.claimInboxBatch('owner', 259, 100)).toEqual([]);
      expect(finding).toHaveBeenCalledTimes(1);
      expect(await inboxRepo.claimInboxBatch('owner', 260, 100)).toEqual([]);
      expect(finding).toHaveBeenCalledTimes(2);
      await inboxRepo.enqueue(reactionEvent('new', 1));
      expect(
        (await inboxRepo.claimInboxBatch('owner', 261, 100)).map((entry) => entry.eventId),
      ).toEqual(['new']);
    });
  });

  it('reclaims crashed inbox consumers and fences acknowledgements', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      const event = reactionEvent('e1', 10);
      await inboxRepo.enqueue(event);
      await inboxRepo.enqueue(event);
      // A claim is not a failure: only reported failures count as attempts.
      expect((await inboxRepo.claimInbox('first', 10, 100))?.attempts).toBe(0);
      expect(await inboxRepo.claimInbox('second', 50, 100)).toBeUndefined();
      expect((await inboxRepo.claimInbox('second', 110, 100))?.attempts).toBe(0);
      await expect(inboxRepo.ackInbox('e1', 'first')).rejects.toThrow('claim lost');
      await inboxRepo.ackInbox('e1', 'second');
      expect(await conn.models.ArchiveInbox.countDocuments()).toBe(0);
    });
  });
  it('defers inaccessible events without starving later writes', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      await inboxRepo.enqueue(reactionEvent('denied', 1));
      await inboxRepo.enqueue(reactionEvent('later', 2));
      expect((await inboxRepo.claimInbox('a', 10, 100))?.eventId).toBe('denied');
      await inboxRepo.deferInbox('denied', 'a', 'source-denied', 1000);
      expect((await inboxRepo.claimInbox('b', 20, 100))?.eventId).toBe('later');
      await inboxRepo.ackInbox('later', 'b');
      expect(await inboxRepo.claimInbox('c', 999, 100)).toBeUndefined();
      expect((await inboxRepo.claimInbox('c', 1000, 100))?.eventId).toBe('denied');
    });
  });
  it('records failure counters and claim streaks under the claim fence', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      const stored = () => conn.models.ArchiveInbox.findOne({ eventId: 'poison' }).lean();
      await inboxRepo.enqueue(reactionEvent('poison', 1));
      expect((await inboxRepo.claimInbox('a', 10, 100))?.claims).toBe(1);
      await expect(inboxRepo.deferInbox('poison', 'stale', 'transient', 20)).rejects.toThrow(
        'claim lost',
      );
      await inboxRepo.deferInbox('poison', 'a', 'transient', 20, {
        attempts: 3,
        firstFailedAt: 10,
      });
      expect(await stored()).toMatchObject({
        state: 'pending',
        attempts: 3,
        firstFailedAt: 10,
        nextAttemptAt: 20,
        claims: 0,
      });
      // A claim that expires without an outcome extends the streak; a release ends it.
      expect((await inboxRepo.claimInbox('b', 20, 100))?.claims).toBe(1);
      expect((await inboxRepo.claimInbox('c', 200, 100))?.claims).toBe(2);
      await inboxRepo.releaseInbox('poison', 'c');
      expect(await stored()).toMatchObject({ state: 'pending', claims: 0, attempts: 3 });
    });
  });
  it('retires dead events from claims, pending counts and the empty-inbox probe', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      await inboxRepo.enqueue(reactionEvent('poison', 1));
      await inboxRepo.enqueue(reactionEvent('later', 2));
      expect((await inboxRepo.claimInbox('b', 20, 100))?.eventId).toBe('poison');
      await expect(
        inboxRepo.deadLetterInbox('poison', { kind: 'claim', token: 'a' }, 'stale token', 30),
      ).rejects.toThrow('claim lost');
      await inboxRepo.deadLetterInbox(
        'poison',
        { kind: 'claim', token: 'b' },
        'still failing',
        30,
        {
          attempts: 11,
        },
      );
      const dead = await conn.models.ArchiveInbox.findOne({ eventId: 'poison' }).lean();
      expect(dead).toMatchObject({ state: 'dead', attempts: 11, deadAt: new Date(30) });
      expect(dead).not.toHaveProperty('claimToken');
      expect(dead).not.toHaveProperty('nextAttemptAt');
      expect((await inboxRepo.claimInbox('c', 40, 100))?.eventId).toBe('later');
      await inboxRepo.ackInbox('later', 'c');
      // Only the dead event remains. Its missing retry time must not defeat the
      // short empty-inbox cache, so a second poll within it issues no query.
      const find = vi.spyOn(conn.models.ArchiveInbox.collection, 'find');
      const now = Date.now();
      expect(await inboxRepo.claimInbox('d', now, 100)).toBeUndefined();
      expect(await inboxRepo.claimInbox('d', now + 1, 100)).toBeUndefined();
      expect(find).toHaveBeenCalledTimes(1);
      find.mockRestore();
      await inboxRepo.enqueue(reactionEvent('next', 3));
      expect((await inboxRepo.claimInbox('d', now + 2, 100))?.eventId).toBe('next');
    });
  });
  it('expires dead letters after 30 days through a TTL index', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      await conn.models.ArchiveInbox.createCollection();
      await conn.models.ArchiveInbox.createIndexes();
      const indexes = await conn.models.ArchiveInbox.collection.indexes();
      expect(indexes.find((index) => index.key['deadAt'] === 1)).toMatchObject({
        expireAfterSeconds: 30 * 24 * 60 * 60,
      });
    });
  });
  it('names an invalid inbox event after claiming the valid events ahead of it', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, inboxRepo } = await openRepo(connection);
      await inboxRepo.enqueue(reactionEvent('valid', 1));
      await conn.models.ArchiveInbox.collection.insertOne({
        eventId: 'broken',
        kind: 'snapshot',
        messageId: '3',
        channelId: '2',
        payload: { content: 'not a normalized snapshot' },
        observedAt: 2,
        state: 'pending',
        attempts: 0,
      });
      expect((await inboxRepo.claimInboxBatch('a', 10, 100)).map((entry) => entry.eventId)).toEqual(
        ['valid'],
      );
      await inboxRepo.ackInbox('valid', 'a');
      const error = await inboxRepo.claimInbox('b', 10, 100).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ArchiveInboxInvalidError);
      expect((error as ArchiveInboxInvalidError).eventId).toBe('broken');
      expect(isArchiveInboxUnclaimable(error)).toBe(true);
      await inboxRepo.deadLetterInbox('broken', { kind: 'unclaimable' }, 'invalid', 10);
      expect(await inboxRepo.claimInbox('b', 10, 100)).toBeUndefined();
    });
  });

  it('rejects a reaction event whose target does not match its contract', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, inboxRepo } = await openRepo(connection);
      await inboxRepo.enqueue({
        ...reactionEvent('targeted', 1),
        payload: { target: { scope: 'emoji' as const, emojiKey: '👍', type: 1 as const } },
      });
      await conn.models.ArchiveInbox.collection.insertOne({
        ...reactionEvent('broken', 2),
        payload: { target: { scope: 'emoji', emojiKey: '' } },
        state: 'pending',
        attempts: 0,
      });
      const claimed = await inboxRepo.claimInboxBatch('token', 10, 60_000);
      expect(claimed.map((entry) => entry.eventId)).toEqual(['targeted']);
      await inboxRepo.ackInbox('targeted', 'token');
      await expect(inboxRepo.claimInboxBatch('token', 10, 60_000)).rejects.toThrow(
        ArchiveInboxInvalidError,
      );
    });
  });

  it('names an unclaimable oversized event so it can be dead-lettered', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const inboxRepo = new MongoArchiveInboxRepo(conn, 'msg-archive');
      const limits = ARCHIVE_LIMITS as { pipelineBytes: number };
      const original = limits.pipelineBytes;
      await inboxRepo.enqueue({
        eventId: 'huge',
        kind: 'gap',
        payload: { reason: 'x'.repeat(4096) },
        observedAt: 1,
      });
      await inboxRepo.enqueue(reactionEvent('small', 2));
      limits.pipelineBytes = 2048;
      try {
        const error = await inboxRepo.claimInbox('a', 10, 100).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ArchiveInboxOversizedError);
        expect(error).toBeInstanceOf(ArchiveLimitExceededError);
        expect(error).not.toBeInstanceOf(RangeError);
        expect((error as ArchiveInboxOversizedError).eventId).toBe('huge');
        await inboxRepo.deadLetterInbox('huge', { kind: 'unclaimable' }, 'oversized', 10);
        expect((await inboxRepo.claimInbox('a', 10, 100))?.eventId).toBe('small');
        await expect(
          inboxRepo.deadLetterInbox('huge', { kind: 'unclaimable' }, 'again', 11),
        ).rejects.toThrow('claim lost');
      } finally {
        limits.pipelineBytes = original;
      }
    });
  });
  it('claims a single fixed owner without requiring indexes or expiry takeover', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const ownerRepo = new MongoArchiveOwnerRepo(conn, 'msg-archive');
      const results = await Promise.all([
        ownerRepo.acquireOwner('a', 10),
        ownerRepo.acquireOwner('b', 10),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const owner = results[0] ? 'a' : 'b';
      expect(await ownerRepo.acquireOwner('c', 999999999)).toBe(false);
      await ownerRepo.releaseOwner('c');
      expect(await ownerRepo.acquireOwner('c', 999999999)).toBe(false);
      await ownerRepo.releaseOwner(owner);
      expect(await ownerRepo.acquireOwner('c', 999999999)).toBe(true);
    });
  });
  it('releases a recorded owner lease only while it still names that owner', async () => {
    await withFreshConnection(async (connection) => {
      const { ownerRepo } = await openRepo(connection);
      expect(await ownerRepo.ownerLease()).toBeNull();
      expect(await ownerRepo.acquireOwner('old', 10)).toBe(true);
      const lease = await ownerRepo.ownerLease();
      expect(lease).toEqual({ id: 'owner', ownerId: 'old' });
      expect(await ownerRepo.releaseOwnerLease(lease?.id, 'other')).toBe(false);
      expect(await ownerRepo.releaseOwnerLease(lease?.id, 'old')).toBe(true);
      expect(await ownerRepo.ownerLease()).toBeNull();
      expect(await ownerRepo.acquireOwner('new', 20)).toBe(true);
    });
  });
  it('does not replace current reaction references with incomplete chunks', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo, reactionRepo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('first'));
      await reactionRepo.stageReactions([chunk('👍', 'a', ['4', '5'], 10)]);
      await reactionRepo.finalizeReactionRefresh('3', 'a', [{ key: '👍:0', chunks: 1 }], 10);
      await reactionRepo.markReactionsStale('3', 20);
      await reactionRepo.stageReactions([chunk('👍', 'b', ['4'], 20)]);
      await expect(
        reactionRepo.finalizeReactionRefresh('3', 'b', [{ key: '👍:0', chunks: 2 }], 20),
      ).rejects.toThrow('Incomplete');
      expect((await stored(connection))?.reactionGenerations?.['👍:0']?.generation).toBe('a');
      expect(
        await conn.models.ArchiveReaction.find({}, { _id: 0, channelId: 1, generation: 1 })
          .sort({ generation: 1 })
          .lean()
          .exec(),
      ).toEqual([
        { channelId: '2', generation: 'a' },
        { channelId: '2', generation: 'b' },
      ]);
      await reactionRepo.finalizeReactionRefresh('3', 'empty', [], 30);
      expect((await stored(connection))?.reactionGenerations).toEqual({});
    });
  });

  it('stages chunks in one insert and publishes every stream of a refresh in one write', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo, reactionRepo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('first'));
      const inserting = vi.spyOn(conn.models.ArchiveReaction.collection, 'insertMany');
      await reactionRepo.stageReactions([
        chunk('👍', 'g', ['4', '5'], 10),
        chunk('👍', 'g', ['6'], 10, 1),
        { ...chunk('50', 'g', ['7'], 10), type: 1 },
      ]);
      expect(inserting).toHaveBeenCalledTimes(1);
      await expect(
        reactionRepo.stageReactions([chunk('👍', 'x', ['not-an-id'], 10)]),
      ).rejects.toThrow('Invalid reaction chunk');
      await expect(
        reactionRepo.stageReactions(
          Array.from({ length: ARCHIVE_LIMITS.batchDocuments + 1 }, (_, index) =>
            chunk('👍', 'y', ['4'], 10, index),
          ),
        ),
      ).rejects.toThrow(ArchiveLimitExceededError);
      await reactionRepo.markReactionsStale('3', 20);
      const before = await stored(connection);
      // A change marked after the refresh began fails the publication.
      await expect(
        reactionRepo.finalizeReactionRefresh('3', 'g', [{ key: '👍:0', chunks: 2 }], 15),
      ).rejects.toThrow('Reaction changed during refresh');
      const updates = vi.spyOn(connection.collection('messages'), 'updateOne');
      const replacements = vi.spyOn(connection.collection('messages'), 'replaceOne');
      await reactionRepo.finalizeReactionRefresh(
        '3',
        'g',
        [
          { key: '👍:0', chunks: 2 },
          { key: '50:1', chunks: 1 },
          { key: '50:0', chunks: 0 },
        ],
        25,
      );
      expect(updates.mock.calls.length + replacements.mock.calls.length).toBe(1);
      const after = await stored(connection);
      expect(after?.reactionGenerations).toEqual({
        '👍:0': { generation: 'g', observedAt: 25, complete: true },
        '50:1': { generation: 'g', observedAt: 25, complete: true },
        '50:0': { generation: 'g', observedAt: 25, complete: true },
      });
      expect(after?.reactionsFreshAt).toBe(25);
      expect(after).not.toHaveProperty('reactionsStaleAt');
      expect(before?.reactionsStaleAt).toBe(20);
      // A missing chunk keeps the published generation.
      await expect(
        reactionRepo.finalizeReactionRefresh('3', 'g', [{ key: '50:1', chunks: 2 }], 30),
      ).rejects.toThrow('Incomplete');
    });
  });

  it('publishes a partial refresh over the other streams and clears only its own stale mark', async () => {
    await withFreshConnection(async (connection) => {
      const { repo, reactionRepo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('first'));
      await reactionRepo.stageReactions([chunk('👍', 'a', ['4'], 10), chunk('50', 'a', ['5'], 10)]);
      await reactionRepo.finalizeReactionRefresh(
        '3',
        'a',
        [
          { key: '👍:0', chunks: 1 },
          { key: '👍:1', chunks: 0 },
          { key: '50:0', chunks: 1 },
          { key: '50:1', chunks: 0 },
        ],
        10,
      );
      await reactionRepo.markReactionsStale('3', 40);
      await reactionRepo.stageReactions([chunk('👍', 'b', ['4', '6'], 50)]);
      await reactionRepo.finalizeReactionRefresh('3', 'b', [{ key: '👍:0', chunks: 1 }], 50, {
        partial: { removedKeys: ['50'], staleMark: 40 },
      });
      const after = await stored(connection);
      expect(after?.reactionGenerations).toEqual({
        '👍:0': { generation: 'b', observedAt: 50, complete: true },
        '👍:1': { generation: 'a', observedAt: 10, complete: true },
      });
      // Freshness belongs to full refreshes.
      expect(after?.reactionsFreshAt).toBe(10);
      expect(after).not.toHaveProperty('reactionsStaleAt');
      // Another change marked meanwhile keeps the lists stale.
      await reactionRepo.markReactionsStale('3', 60);
      await reactionRepo.markReactionsStale('3', 70);
      await reactionRepo.stageReactions([chunk('👍', 'c', ['4'], 80)]);
      await reactionRepo.finalizeReactionRefresh('3', 'c', [{ key: '👍:0', chunks: 1 }], 80, {
        partial: { removedKeys: [], staleMark: 60 },
      });
      expect((await stored(connection))?.reactionsStaleAt).toBe(70);
    });
  });

  it('moves the stale mark only forward and merges it into snapshot writes', async () => {
    await withFreshConnection(async (connection) => {
      const { repo, reactionRepo } = await openRepo(connection);
      const first = snapshot('first');
      await repo.persistSnapshot(first);
      const replacing = vi.spyOn(connection.collection('messages'), 'replaceOne');
      const updating = vi.spyOn(connection.collection('messages'), 'updateOne');
      const writes = () => replacing.mock.calls.length + updating.mock.calls.length;
      await reactionRepo.markReactionsStale('3', 30);
      await reactionRepo.markReactionsStale('3', 20);
      // An equal mark is not rewritten either.
      await reactionRepo.markReactionsStale('3', 30);
      expect(writes()).toBe(1);
      expect((await stored(connection))?.reactionsStaleAt).toBe(30);
      // Content unchanged: the mark and freshness are written, the outcome stays unchanged.
      expect(
        await repo.persistSnapshot(
          { ...first, observedAt: first.observedAt + 10 },
          { staleReactions: 40 },
        ),
      ).toBe('unchanged');
      expect((await stored(connection))?.reactionsStaleAt).toBe(40);
      // An observation too old to apply still records the mark.
      expect(await repo.persistSnapshot(first, { staleReactions: 50 })).toBe('stale');
      expect((await stored(connection))?.reactionsStaleAt).toBe(50);
      const marked = writes();
      expect(await repo.persistSnapshot(first, { staleReactions: 45 })).toBe('stale');
      expect(await repo.persistSnapshot(first, { staleReactions: 50 })).toBe('stale');
      expect(writes()).toBe(marked);
      expect((await stored(connection))?.reactionsStaleAt).toBe(50);
      // Deleted messages are not refreshed, so they are not marked.
      await repo.tombstone('3', '2', created + 5000);
      await repo.persistSnapshot(
        { ...first, observedAt: created + 6000 },
        { staleReactions: created + 6000 },
      );
      expect((await stored(connection))?.reactionsStaleAt).toBe(50);
    });
  });

  it('collects unreferenced old membership chunks, including those of missing messages', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, repo, reactionRepo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('first'));
      await reactionRepo.stageReactions([chunk('👍', 'live', ['4'], 10)]);
      await reactionRepo.finalizeReactionRefresh('3', 'live', [{ key: '👍:0', chunks: 1 }], 10);
      await reactionRepo.stageReactions([
        chunk('👍', 'abandoned', ['4'], 10),
        chunk('👍', 'running', ['4'], 10),
        chunk('👍', 'recent', ['4'], 100),
        chunk('👍', 'orphan', ['4'], 10, 0, '9'),
      ]);
      expect(await reactionRepo.collectReactionGarbage('3', ['running'], 50)).toBe(1);
      expect(await reactionRepo.collectReactionGarbage('9', [], 50)).toBe(1);
      expect(
        (await conn.models.ArchiveReaction.find({}).lean().exec())
          .map((chunk) => chunk.generation)
          .sort(),
      ).toEqual(['live', 'recent', 'running']);
    });
  });

  it('keeps interaction records free of reaction metadata and edit history', async () => {
    await withFreshConnection(async (connection) => {
      const { repo, reactionRepo } = await openRepo(connection);
      await repo.persistSnapshot(snapshot('full'));
      await repo.persistSnapshot(snapshot('edited', created + 1000));
      await repo.persistSnapshot({
        ...normalizeMessage({ id: '3', channel_id: '2', type: 0 }, { observedAt: created + 2000 }),
        excludedFields: ['content', 'attachments', 'embeds', 'reactions', 'editedTimestamp'],
        policy: { version: '1', reason: 'interaction-record' },
      });
      await reactionRepo.markReactionsStale('3', created + 3000);
      const after = await stored(connection);
      expect(after).toMatchObject({
        excludedFields: ['content', 'attachments', 'embeds', 'reactions', 'editedTimestamp'],
        policy: { version: '1', reason: 'interaction-record' },
      });
      for (const field of ['content', 'editHistory', 'editedTimestamp', 'reactionsStaleAt'])
        expect(after).not.toHaveProperty(field);
    });
  });

  it("treats a scan's channel record as authoritative for the parent", async () => {
    await withFreshConnection(async (connection) => {
      const { conn, channelRepo } = await openRepo(connection);
      const channel = { channelId: '2', name: 'general', type: 0, observedAt: 1 } as const;
      await channelRepo.upsertChannel({
        ...channel,
        parentId: '1',
        access: 'readable',
        everyoneCanView: true,
      });
      await channelRepo.recordChannel({ channelId: '2', observedAt: 2, everyoneCanView: false });
      expect(
        await conn.models.ArchiveChannel.findOne({ channelId: '2' }).lean().exec(),
      ).toMatchObject({ parentId: '1', everyoneCanView: false });
      // Moved out of its category.
      await channelRepo.upsertChannel({ ...channel, observedAt: 3, access: 'readable' });
      const after = await conn.models.ArchiveChannel.findOne({ channelId: '2' }).lean().exec();
      expect(after).not.toHaveProperty('parentId');
      expect(after?.everyoneCanView).toBe(false);
    });
  });

  it('records live channel observations and keeps deleted channels', async () => {
    await withFreshConnection(async (connection) => {
      const { conn, channelRepo } = await openRepo(connection);
      await channelRepo.upsertChannel({
        channelId: '2',
        name: 'general',
        type: 0,
        parentId: '1',
        observedAt: 1,
        access: 'readable',
        checkpoints: { periodic: { runId: 'r', cutoff: 1, before: '9', complete: false } },
      });
      await channelRepo.recordChannel({
        channelId: '2',
        observedAt: 2,
        name: 'renamed',
        parentId: null,
      });
      await channelRepo.recordChannel({ channelId: '2', observedAt: 3, access: 'deleted' });
      await channelRepo.recordChannel({
        channelId: '7',
        observedAt: 4,
        name: 'thread',
        type: 11,
        parentId: '2',
        everyoneCanView: false,
        initialAccess: 'readable',
      });
      const channels = await conn.models.ArchiveChannel.find({}, { _id: 0 })
        .sort({ channelId: 1 })
        .lean()
        .exec();
      expect(channels).toEqual([
        {
          channelId: '2',
          name: 'renamed',
          type: 0,
          observedAt: 3,
          access: 'deleted',
          checkpoints: { periodic: { runId: 'r', cutoff: 1, before: '9', complete: false } },
        },
        {
          channelId: '7',
          name: 'thread',
          type: 11,
          parentId: '2',
          observedAt: 4,
          access: 'readable',
          everyoneCanView: false,
        },
      ]);
    });
  });

  it.each([
    ['messages', MongoArchiveRepo],
    ['inbox', MongoArchiveInboxRepo],
    ['reactions', MongoArchiveReactionRepo],
    ['channels', MongoArchiveChannelRepo],
    ['jobs', MongoArchiveJobRepo],
    ['owner', MongoArchiveOwnerRepo],
  ] as const)(
    'refuses the %s writer repository without msg-archive ownership',
    async (_name, Repo) => {
      await withFreshConnection(async (connection) => {
        const conn = await new StaticConnectionManager(connection).getConnection(guildId);
        expect(() => new Repo({ ...conn, archiveOwner: undefined }, 'msg-archive')).toThrow(
          'ownership',
        );
        expect(() => new Repo(conn, 'reader' as never)).toThrow('ownership');
        expect(() => new Repo(conn, 'msg-archive')).not.toThrow();
      });
    },
  );

  it('rejects mutation capabilities from reader compositions and routes every intercepted mutation', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const reader = buildRepos({ ...conn, archiveOwner: undefined });
      // Reader compositions expose no archive writer and no legacy cursor writer.
      expect(Object.keys(reader)).toEqual(expect.not.arrayContaining(['archive', 'fetch']));
      const statsMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(reader.archiveStats));
      expect(statsMethods.some((key) => /insert|write|update|delete/i.test(key))).toBe(false);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const reactionRepo = new MongoArchiveReactionRepo(conn, 'msg-archive');
      const channelRepo = new MongoArchiveChannelRepo(conn, 'msg-archive');
      const mutations: string[] = [];
      const interceptor: ArchiveMutationInterceptor = async (collectionName, before, after) => {
        expect(after?._id ?? before?._id).toBeTruthy();
        mutations.push(collectionName);
      };
      await repo.persistSnapshot(snapshot('first'), { interceptor });
      await channelRepo.upsertChannel(
        { channelId: '2', name: 'general', type: 0, access: 'readable', observedAt: 10 },
        { interceptor },
      );
      await channelRepo.recordChannel({ channelId: '2', observedAt: 11 }, { interceptor });
      await reactionRepo.stageReactions([chunk('👍', 'a', ['4'], 10)], { interceptor });
      expect(mutations).toEqual([
        'messages',
        'archive_channels',
        'archive_channels',
        'archive_reactions',
      ]);
      expect(await conn.models.Message.countDocuments()).toBe(0);
    });
  });
});
