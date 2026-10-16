/**
 * The archive write primitives. The `$expr` before-image fence itself is
 * proven against a real MongoDB in `archive-repo.int.test.ts`; this
 * suite pins the decisions made before the driver is reached — owner
 * checks, `_id` placement, the size guard, the interceptor hand-off, and
 * which write a mutation becomes — against a recording collection.
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ARCHIVE_SCHEMA_VERSION, type ArchiveMessage } from '../../../src/core/archive/types';
import { asGuildId } from '../../../src/core/ids';
import type { ArchiveOwner, GuildConnection } from '../../../src/persistence/connection';
import {
  archiveDocumentBytes,
  archiveMessages,
  assertArchiveWriter,
  metadataUpdate,
  sameArchiveDocument,
  withoutMetadata,
  writeArchiveDocument,
  type ArchiveMutationInterceptor,
} from '../../../src/persistence/repositories/archive-mutation';

type Write = readonly [operation: string, ...args: unknown[]];

/**
 * A guild connection whose collections record every write. `matched`
 * is what the fenced writes report, so a conflict can be simulated.
 */
const recordingConnection = (archiveOwner?: ArchiveOwner, matched = 1) => {
  const writes: Write[] = [];
  const opened: string[] = [];
  const collection = {
    insertOne: async (doc: unknown) => {
      writes.push(['insertOne', doc]);
      return { acknowledged: true };
    },
    deleteOne: async (filter: unknown) => {
      writes.push(['deleteOne', filter]);
      return { deletedCount: matched };
    },
    replaceOne: async (filter: unknown, doc: unknown) => {
      writes.push(['replaceOne', filter, doc]);
      return { matchedCount: matched };
    },
    updateOne: async (filter: unknown, update: unknown) => {
      writes.push(['updateOne', filter, update]);
      return { matchedCount: matched };
    },
  };
  // The writer reads only `archiveOwner` and `connection.collection`; a
  // real mongoose `Connection` would need a live server to answer them.
  const conn = {
    guildId: asGuildId('100000000000000001'),
    archiveOwner,
    connection: {
      collection: (name: string) => {
        opened.push(name);
        return collection;
      },
    },
    models: {},
  } as unknown as GuildConnection;
  return { conn, writes, opened, collection };
};

const message = (overrides: Partial<ArchiveMessage> = {}): ArchiveMessage => ({
  _id: '200000000000000001',
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  channelId: '300000000000000001',
  createdTimestamp: 1_000,
  observedAt: 2_000,
  content: 'hello',
  ...overrides,
});

describe('archiveDocumentBytes', () => {
  it('measures the BSON size the archive stores', () => {
    expect(archiveDocumentBytes({})).toBe(5);
    // 4 (length) + 1 (type) + 2 ("a\0") + 4 (string length) + 2 ("x\0") + 1 (terminator)
    expect(archiveDocumentBytes({ a: 'x' })).toBe(14);
  });
});

describe('assertArchiveWriter', () => {
  it('admits only the msg-archive owner on a msg-archive connection', () => {
    expect(() =>
      assertArchiveWriter(recordingConnection('msg-archive').conn, 'msg-archive'),
    ).not.toThrow();
  });

  it('refuses a connection that was not opened for the archive', () => {
    expect(() => assertArchiveWriter(recordingConnection().conn, 'msg-archive')).toThrow(
      'Archive writes require msg-archive ownership',
    );
  });
});

describe('archiveMessages', () => {
  it('opens the raw messages collection', () => {
    const { conn, opened, collection } = recordingConnection('msg-archive');

    expect(archiveMessages(conn)).toBe(collection);
    expect(opened).toEqual(['messages']);
  });
});

describe('writeArchiveDocument', () => {
  const intercepted = () => {
    const seen: Parameters<ArchiveMutationInterceptor>[] = [];
    const interceptor: ArchiveMutationInterceptor = async (...args) => {
      seen.push(args);
    };
    return { seen, interceptor };
  };

  it('hands an interceptor the mutation instead of writing it', async () => {
    const { conn, writes } = recordingConnection('msg-archive');
    const { seen, interceptor } = intercepted();
    const before = message();
    const after = message({ content: 'edited' });

    await writeArchiveDocument(conn, 'messages', before, after, 'edit', { interceptor });

    expect(seen).toEqual([['messages', before, after, 'edit']]);
    expect(writes).toEqual([]);
  });

  it('gives an inserted document without an _id a fresh ObjectId, stored first', async () => {
    const { conn } = recordingConnection('msg-archive');
    const { seen, interceptor } = intercepted();

    await writeArchiveDocument(conn, 'archive_channels', null, { name: 'general' }, 'create', {
      interceptor,
    });

    const after = seen[0]?.[2];
    expect(Object.keys(after ?? {})).toEqual(['_id', 'name']);
    expect(after?.['_id']).toBeInstanceOf(Types.ObjectId);
  });

  it('moves an existing _id to the front so the stored image compares equal', async () => {
    const { conn } = recordingConnection('msg-archive');
    const { seen, interceptor } = intercepted();

    await writeArchiveDocument(conn, 'messages', null, { content: 'x', _id: 'm1' }, 'create', {
      interceptor,
    });

    expect(seen[0]?.[2]).toEqual({ _id: 'm1', content: 'x' });
    expect(Object.keys(seen[0]?.[2] ?? {})).toEqual(['_id', 'content']);
  });

  it('refuses a document over the safe BSON limit before anything is written', async () => {
    const { conn, writes } = recordingConnection('msg-archive');
    const { seen, interceptor } = intercepted();
    const huge = message({ content: 'x'.repeat(15 * 1024 * 1024) });

    await expect(
      writeArchiveDocument(conn, 'messages', null, huge, 'create', { interceptor }),
    ).rejects.toThrow('Archive document exceeds safe BSON limit');
    await expect(writeArchiveDocument(conn, 'messages', null, huge, 'create')).rejects.toThrow();
    expect(seen).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('inserts a new document into the named collection', async () => {
    const { conn, writes, opened } = recordingConnection('msg-archive');
    const after = message();

    await writeArchiveDocument(conn, 'messages', null, after, 'create');

    expect(opened).toEqual(['messages']);
    expect(writes).toEqual([['insertOne', after]]);
  });

  it('fences a deletion on the full before-image', async () => {
    const { conn, writes } = recordingConnection('msg-archive');
    const before = message();

    await writeArchiveDocument(conn, 'messages', before, null, 'delete');

    expect(writes).toEqual([
      ['deleteOne', { _id: before._id, $expr: { $eq: ['$$ROOT', { $literal: before }] } }],
    ]);
  });

  it('replaces the document when its content changed', async () => {
    const { conn, writes } = recordingConnection('msg-archive');
    const before = message();
    const after = message({ content: 'edited' });

    await writeArchiveDocument(conn, 'messages', before, after, 'edit');

    expect(writes).toEqual([['replaceOne', expect.objectContaining({ _id: before._id }), after]]);
  });

  it('sends only the changed metadata when nothing else changed', async () => {
    const { conn, writes } = recordingConnection('msg-archive');

    await writeArchiveDocument(conn, 'messages', message(), message({ observedAt: 3_000 }), 'seen');

    expect(writes).toEqual([
      [
        'updateOne',
        expect.objectContaining({ _id: '200000000000000001' }),
        { $set: { observedAt: 3_000 } },
      ],
    ]);
  });

  it.each([
    ['replacement', message({ content: 'edited' })],
    ['metadata update', message({ observedAt: 3_000 })],
    ['deletion', null],
  ])('reports a conflict when the fenced %s matches nothing', async (_kind, after) => {
    const { conn } = recordingConnection('msg-archive', 0);

    await expect(writeArchiveDocument(conn, 'messages', message(), after, 'x')).rejects.toThrow(
      'Archive write conflict',
    );
  });

  it('writes nothing for a mutation with neither image', async () => {
    const { conn, writes } = recordingConnection('msg-archive');

    await writeArchiveDocument(conn, 'messages', null, null, 'noop');

    expect(writes).toEqual([]);
  });
});

describe('sameArchiveDocument', () => {
  it('compares the stored bytes, so field order and numeric type matter', () => {
    expect(sameArchiveDocument({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    expect(sameArchiveDocument({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(false);
    expect(sameArchiveDocument({ a: 1 }, { a: 1.5 })).toBe(false);
  });
});

describe('withoutMetadata', () => {
  it('drops the backup bookkeeping fields and keeps the content', () => {
    const stored = message({
      reactionGenerations: {},
      reactionsFreshAt: 1,
      reactionsStaleAt: 2,
      deletedAt: 3,
    });

    expect(withoutMetadata(stored)).toEqual({
      _id: '200000000000000001',
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      channelId: '300000000000000001',
      createdTimestamp: 1_000,
      content: 'hello',
      deletedAt: 3,
    });
  });
});

describe('metadataUpdate', () => {
  const base = { _id: 'm1', content: 'hi', observedAt: 1, reactionsStaleAt: 5 };

  it('sets the metadata fields that changed', () => {
    expect(metadataUpdate(base, { ...base, observedAt: 2 })).toEqual({ $set: { observedAt: 2 } });
  });

  it('unsets a metadata field the new image dropped', () => {
    const { reactionsStaleAt: _dropped, ...after } = base;

    expect(metadataUpdate(base, after)).toEqual({ $unset: { reactionsStaleAt: 1 } });
  });

  it('combines a set and an unset', () => {
    expect(metadataUpdate(base, { _id: 'm1', content: 'hi', observedAt: 9 })).toEqual({
      $set: { observedAt: 9 },
      $unset: { reactionsStaleAt: 1 },
    });
  });

  it.each([
    ['content changed', { ...base, content: 'edited' }],
    ['a field was added', { ...base, reactionsFreshAt: 3 }],
    ['fields were reordered', { content: 'hi', _id: 'm1', observedAt: 1, reactionsStaleAt: 5 }],
    ['a content field was dropped', { _id: 'm1', observedAt: 1, reactionsStaleAt: 5 }],
    ['nothing changed', { ...base }],
  ])('leaves a replacement to the caller when %s', (_case, after) => {
    expect(metadataUpdate(base, after)).toBeUndefined();
  });
});
