import { mongo } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { normalizeMessage } from '../../../src/core/archive/normalize';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import {
  MongoArchiveRepo,
  type ArchiveMutationInterceptor,
} from '../../../src/persistence/repositories/archive.repo';
import { buildRepos } from '../../../src/persistence/repositories';
import { withFreshConnection } from '../helpers/mongo';
const guildId = asGuildId('1');
const snapshot = (content: string, edited = 1700000000000) =>
  normalizeMessage(
    {
      id: '3',
      channel_id: '2',
      author: { id: '4', username: 'Alice' },
      content,
      timestamp: '2023-11-14T22:13:20.000Z',
      edited_timestamp: new Date(edited).toISOString(),
      attachments: [],
      reactions: [],
    },
    { guildId: '1', channelName: 'general', source: 'history', observedAt: edited },
  );
describe('Mongo archive durability', () => {
  it('preserves intercepted insert image bytes when MongoDB places the identity first', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const persisted: string[] = [];
      const interceptor: ArchiveMutationInterceptor = async (collection, before, after) => {
        expect(before).toBeNull();
        if (after === null) throw new Error('Expected a new archive record');
        const target = connection.collection<Record<string, unknown>>(collection);
        await target.insertOne(after);
        const stored = await target.findOne({});
        expect(stored).not.toBeNull();
        expect(mongo.BSON.serialize(stored!)).toEqual(mongo.BSON.serialize(after));
        persisted.push(collection);
      };
      await repo.upsertChannel(
        { channelId: '2', name: 'general', type: 0, observedAt: 1700000000000, access: 'readable' },
        { interceptor },
      );
      await repo.persistSnapshot(snapshot('first'), { interceptor });
      expect(persisted).toEqual(['archive_channels', 'messages']);
    });
  });

  it('batch-loads observations once and preserves successive versions of the same identity', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const loading = vi.spyOn(repo, 'loadSnapshotBatch');
      const outcomes = await repo.persistSnapshotsBatch([
        snapshot('A'),
        snapshot('B', 1700000001000),
        snapshot('A', 1700000002000),
      ]);
      expect(loading).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(['inserted', 'updated', 'updated']);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.content).toBe('A');
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(2);
    });
  });

  it('skips identical durable images while persisting newer freshness metadata', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const first = snapshot('same');
      await repo.persistSnapshot(first);
      const replacing = vi.spyOn(conn.models.Message.collection, 'replaceOne');
      expect(await repo.persistSnapshot(first)).toBe('unchanged');
      expect(replacing).not.toHaveBeenCalled();
      expect(await repo.persistSnapshot({ ...first, observedAt: first.observedAt + 1000 })).toBe(
        'unchanged',
      );
      expect(replacing).toHaveBeenCalledTimes(1);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.observedAt).toBe(
        first.observedAt + 1000,
      );
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(0);
    });
  });

  it('fences cached no-op observations against an external modification', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const first = snapshot('same');
      await repo.persistSnapshot(first);
      const cached = await repo.loadSnapshotBatch(['3']);
      await conn.models.Message.collection.updateOne(
        { messageId: '3' },
        { $set: { content: 'external' } },
      );
      await expect(repo.persistSnapshot(first, { observed: cached.get('3')! })).rejects.toThrow(
        'Archive write conflict',
      );
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.content).toBe(
        'external',
      );
    });
  });

  it('keeps operation-scoped interceptors isolated from the ambient repair interceptor', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const ambient = vi.fn(async () => {
        throw new Error('unexpected ambient interceptor');
      });
      const first = vi.fn<ArchiveMutationInterceptor>(async () => undefined);
      const second = vi.fn<ArchiveMutationInterceptor>(async () => undefined);
      repo.setMutationInterceptor(ambient);
      await Promise.all([
        repo.persistSnapshot(snapshot('A'), { observed: null, interceptor: first }),
        repo.persistSnapshot(
          { ...snapshot('B'), messageId: '5' },
          { observed: null, interceptor: second },
        ),
      ]);
      expect(ambient).not.toHaveBeenCalled();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first.mock.calls[0]?.[2]).toMatchObject({ messageId: '3', content: 'A' });
      expect(second.mock.calls[0]?.[2]).toMatchObject({ messageId: '5', content: 'B' });
    });
  });

  it('renews bounded inbox claims, tolerates acknowledged members and rejects foreign leases', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      for (const eventId of ['a', 'b', 'c'])
        await repo.enqueue({ eventId, kind: 'snapshot', payload: {}, observedAt: 1 });
      expect(
        (await repo.claimInboxBatch('owner', 10, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['a', 'b']);
      await repo.ackInbox('a', 'owner');
      await repo.renewInboxBatch('owner', ['a', 'b'], 50, 100);
      expect(
        (await repo.claimInboxBatch('other', 110, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['c']);
      await expect(repo.renewInboxBatch('other', ['b'], 120, 100)).rejects.toThrow('claim lost');
      expect(
        (await repo.claimInboxBatch('other', 150, 100, 2)).map((entry) => entry.eventId),
      ).toEqual(['b']);
      await expect(repo.ackInbox('b', 'owner')).rejects.toThrow('claim lost');
    });
  });

  it('bounds empty polling and invalidates the cache as soon as a local event is enqueued', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const finding = vi.spyOn(conn.models.ArchiveInbox.collection, 'find');
      expect(await repo.claimInboxBatch('owner', 10, 100)).toEqual([]);
      expect(await repo.claimInboxBatch('owner', 100, 100)).toEqual([]);
      expect(await repo.claimInboxBatch('owner', 259, 100)).toEqual([]);
      expect(finding).toHaveBeenCalledTimes(1);
      expect(await repo.claimInboxBatch('owner', 260, 100)).toEqual([]);
      expect(finding).toHaveBeenCalledTimes(2);
      await repo.enqueue({ eventId: 'new', kind: 'snapshot', payload: {}, observedAt: 1 });
      expect((await repo.claimInboxBatch('owner', 261, 100)).map((entry) => entry.eventId)).toEqual(
        ['new'],
      );
    });
  });

  it('preserves every actual edit and handles retry after revision commit', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      await repo.persistSnapshot(snapshot('first'));
      const originalReplace = conn.models.Message.collection.replaceOne.bind(
        conn.models.Message.collection,
      );
      conn.models.Message.collection.replaceOne = async () => {
        throw new Error('crash after revision');
      };
      await expect(repo.persistSnapshot(snapshot('second', 1700000001000))).rejects.toThrow(
        'crash',
      );
      conn.models.Message.collection.replaceOne = originalReplace;
      await repo.persistSnapshot(snapshot('second', 1700000001000));
      await repo.persistSnapshot(snapshot('third', 1700000002000));
      await repo.persistSnapshot(snapshot('second', 1700000001000));
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(2);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.content).toBe(
        'third',
      );
      await repo.tombstone('3', '2', 1700000003000);
      await repo.persistSnapshot(snapshot('third', 1700000002000));
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.deletion,
      ).toBeTruthy();
    });
  });
  it('does not manufacture revisions for stale same-content snapshots', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      await repo.persistSnapshot(snapshot('same', 1700000002000));
      expect(await repo.persistSnapshot(snapshot('same', 1700000001000))).toBe('stale');
      await repo.tombstone('3', '2', 1700000003000);
      await repo.persistSnapshot(snapshot('same', 1700000002000));
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(0);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.content).toBe(
        'same',
      );
    });
  });
  it('retains A-B-A observed embed changes with unchanged edit timestamps and ignores event replay', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const observed = (label: string, id: string, at: number) =>
        normalizeMessage(
          {
            id: '3',
            channel_id: '2',
            author: { id: '4', username: 'Alice' },
            content: 'hello',
            embeds: [{ title: label }],
            timestamp: '2023-11-14T22:13:20.000Z',
            edited_timestamp: null,
          },
          { guildId: '1', source: 'gateway', observedAt: at, observationId: id },
        );
      await repo.persistSnapshot(observed('A', 'e1', 1700000001000));
      await repo.persistSnapshot(observed('B', 'e2', 1700000002000));
      await repo.persistSnapshot(observed('A', 'e3', 1700000003000));
      await repo.persistSnapshot(observed('C', 'e4', 1700000004000));
      const revisions = await conn.models.ArchiveRevision.find({})
        .sort({ versionObservationId: 1 })
        .lean()
        .exec();
      expect(revisions.map((entry) => entry.versionObservationId)).toEqual(['e1', 'e2', 'e3']);
      await repo.persistSnapshot(observed('A', 'e3', 1700000003000));
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.embeds[0].title,
      ).toBe('C');
      const refreshed = normalizeMessage(
        {
          id: '3',
          channel_id: '2',
          author: { id: '4', username: 'Alice' },
          content: 'hello',
          embeds: [{ title: 'C' }],
          timestamp: '2023-11-14T22:13:20.000Z',
          edited_timestamp: null,
        },
        { guildId: '1', source: 'history', observedAt: 1700000005000 },
      );
      await repo.persistSnapshot(refreshed);
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.versionObservationId,
      ).toBe('e4');
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(3);
    });
  });
  it('recovers Gateway transitions after revision commit and preserves REST-interleaved A-B-A', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const observed = (content: string, id: string, at: number) =>
        normalizeMessage(
          {
            id: '3',
            channel_id: '2',
            author: { id: '4', username: 'Alice' },
            content,
            timestamp: '2023-11-14T22:13:20.000Z',
            edited_timestamp: null,
          },
          { guildId: '1', source: 'gateway', observedAt: at, observationId: id },
        );
      await repo.persistSnapshot(
        observed('A', 'session:00000000000000000001:MESSAGE_UPDATE', 1700000001000),
      );
      await repo.persistSnapshot(
        normalizeMessage(
          {
            id: '3',
            channel_id: '2',
            content: 'A',
            timestamp: '2023-11-14T22:13:20.000Z',
            edited_timestamp: null,
          },
          { guildId: '1', source: 'history', observedAt: 1700000010000 },
        ),
      );
      const originalReplace = conn.models.Message.collection.replaceOne.bind(
        conn.models.Message.collection,
      );
      conn.models.Message.collection.replaceOne = async () => {
        throw new Error('crash before watermark');
      };
      await expect(
        repo.persistSnapshot(
          observed('B', 'session:00000000000000000002:MESSAGE_UPDATE', 1700000002000),
        ),
      ).rejects.toThrow('watermark');
      conn.models.Message.collection.replaceOne = originalReplace;
      await repo.persistSnapshot(
        observed('B', 'session:00000000000000000002:MESSAGE_UPDATE', 1700000002000),
      );
      await repo.persistSnapshot(
        observed('A', 'session:00000000000000000003:MESSAGE_UPDATE', 1700000003000),
      );
      await repo.persistSnapshot(
        observed('C', 'session:00000000000000000004:MESSAGE_UPDATE', 1700000011000),
      );
      const revisions = await conn.models.ArchiveRevision.find({}).lean().exec();
      expect(revisions.map((entry) => entry.versionObservationId)).toEqual(
        expect.arrayContaining([
          'session:00000000000000000001:MESSAGE_UPDATE',
          'session:00000000000000000002:MESSAGE_UPDATE',
          'session:00000000000000000003:MESSAGE_UPDATE',
        ]),
      );
      await repo.persistSnapshot(
        observed('B', 'session:00000000000000000002:MESSAGE_UPDATE', 1700000099000),
      );
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(revisions.length);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.content).toBe('C');
    });
  });
  it('does not treat unknown omitted Gateway fields as a content transition', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const first = normalizeMessage(
        { id: '3', channel_id: '2', content: 'A', embeds: [{ title: 'notice' }] },
        { guildId: '1', source: 'gateway', observedAt: 10, observationId: 'e1' },
      );
      await repo.persistSnapshot(first);
      await repo.persistSnapshot(
        normalizeMessage(
          { id: '3', channel_id: '2', content: 'A' },
          { guildId: '1', source: 'gateway', observedAt: 20, observationId: 'e2' },
        ),
      );
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(0);
      expect((await conn.models.Message.collection.findOne({ messageId: '3' }))?.embeds).toEqual([
        { title: 'notice' },
      ]);
    });
  });
  it('reclaims crashed inbox consumers and fences acknowledgements', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const event = {
        eventId: 'e1',
        kind: 'snapshot' as const,
        payload: { content: 'x' },
        observedAt: 10,
      };
      await repo.enqueue(event);
      await repo.enqueue(event);
      expect((await repo.claimInbox('first', 10, 100))?.attempts).toBe(1);
      expect(await repo.claimInbox('second', 50, 100)).toBeUndefined();
      expect((await repo.claimInbox('second', 110, 100))?.attempts).toBe(2);
      await expect(repo.ackInbox('e1', 'first')).rejects.toThrow('claim lost');
      await repo.ackInbox('e1', 'second');
      expect(await conn.models.ArchiveInbox.countDocuments()).toBe(0);
    });
  });
  it('defers inaccessible events without starving later writes', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      await repo.enqueue({ eventId: 'denied', kind: 'reaction', payload: {}, observedAt: 1 });
      await repo.enqueue({ eventId: 'later', kind: 'snapshot', payload: {}, observedAt: 2 });
      expect((await repo.claimInbox('a', 10, 100))?.eventId).toBe('denied');
      await repo.deferInbox('denied', 'a', 'source-denied', 1000);
      expect((await repo.claimInbox('b', 20, 100))?.eventId).toBe('later');
      await repo.ackInbox('later', 'b');
      expect(await repo.claimInbox('c', 999, 100)).toBeUndefined();
      expect((await repo.claimInbox('c', 1000, 100))?.eventId).toBe('denied');
    });
  });
  it('claims a single fixed owner without requiring indexes or expiry takeover', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const results = await Promise.all([repo.acquireOwner('a', 10), repo.acquireOwner('b', 10)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const owner = results[0] ? 'a' : 'b';
      expect(await repo.acquireOwner('c', 999999999)).toBe(false);
      await repo.releaseOwner('c');
      expect(await repo.acquireOwner('c', 999999999)).toBe(false);
      await repo.releaseOwner(owner);
      expect(await repo.acquireOwner('c', 999999999)).toBe(true);
    });
  });
  it('does not replace current reaction references with incomplete chunks', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      await repo.persistSnapshot(snapshot('first'));
      await repo.stageReaction('3', 'unicode:👍', 0, 'a', 0, ['4', '5'], 10);
      await repo.publishReaction('3', 'unicode:👍', 0, 'a', 1, 10);
      await repo.finalizeReactionRefresh('3', 'a', ['unicode:👍:0'], 10);
      await repo.markReactionsStale('3', 20);
      await repo.stageReaction('3', 'unicode:👍', 0, 'b', 0, ['4'], 20);
      await expect(repo.publishReaction('3', 'unicode:👍', 0, 'b', 2, 20)).rejects.toThrow(
        'Incomplete',
      );
      const stored = await conn.models.Message.collection.findOne({ messageId: '3' });
      expect(stored?.reactionGenerations['unicode:👍:0'].generation).toBe('a');
      await repo.finalizeReactionRefresh('3', 'empty', [], 30);
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.reactionGenerations,
      ).toEqual({});
    });
  });
  it('records excluded-source evidence without copying excluded content or creating revisions', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      await repo.persistSnapshot(snapshot('legacy body'));
      const evidence = { ...snapshot('excluded secret'), authorKind: 'bot' as const };
      await repo.recordSourceEvidence('3', evidence, {
        policyHash: 'p1',
        admitted: false,
        reason: 'content-rule',
        observedAt: 1700000002000,
      });
      await repo.recordSourceEvidence('not-stored', evidence);
      const stored = await conn.models.Message.collection.findOne({ messageId: '3' });
      expect(stored?.authorKind).toBe('bot');
      expect(stored?.content).toBe('legacy body');
      expect(stored?.archiveSourceDecision).toMatchObject({
        policyHash: 'p1',
        admitted: false,
        reason: 'content-rule',
      });
      await repo.recordSourceEvidence(
        '3',
        { ...evidence, authorKind: 'unknown' },
        { policyHash: 'p1', admitted: false, reason: 'newer-partial', observedAt: 1700000003000 },
      );
      await repo.recordSourceEvidence('3', evidence, {
        policyHash: 'p1',
        admitted: false,
        reason: 'older-proof',
        observedAt: 1700000001000,
      });
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.archiveSourceDecision
          .reason,
      ).toBe('newer-partial');
      await repo.persistSnapshot(snapshot('legacy body', 1700000004000));
      expect(
        (await conn.models.Message.collection.findOne({ messageId: '3' }))?.archiveSourceDecision,
      ).toBeUndefined();
      expect(await conn.models.Message.countDocuments()).toBe(1);
      expect(await conn.models.ArchiveRevision.countDocuments()).toBe(0);
    });
  });
  it('rejects mutation capabilities from reader compositions and journals every intercepted mutation', async () => {
    await withFreshConnection(async (connection) => {
      const conn = await new StaticConnectionManager(connection).getConnection(guildId);
      const reader = buildRepos({ ...conn, archiveOwner: undefined });
      expect(reader.archive).toBeUndefined();
      expect('insertManyIgnoringDuplicates' in reader.message).toBe(false);
      expect('upsertLastMessageID' in reader.fetch).toBe(false);
      expect(
        () => new MongoArchiveRepo({ ...conn, archiveOwner: undefined }, 'msg-archive'),
      ).toThrow('ownership');
      const repo = new MongoArchiveRepo(conn, 'msg-archive');
      const mutations: string[] = [];
      repo.setMutationInterceptor(async (collectionName, before, after) => {
        expect(after?._id ?? before?._id).toBeTruthy();
        mutations.push(collectionName);
      });
      await repo.persistSnapshot(snapshot('first'));
      await repo.upsertChannel({
        channelId: '2',
        name: 'general',
        type: 0,
        access: 'readable',
        observedAt: 10,
      });
      await repo.stageReaction('3', 'unicode:👍', 0, 'a', 0, ['4'], 10);
      expect(mutations).toEqual(['messages', 'archive_channels', 'archive_reactions']);
      expect(await conn.models.Message.countDocuments()).toBe(0);
    });
  });
});
