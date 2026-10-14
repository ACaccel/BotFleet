/**
 * Pins the `/db` collection catalog to what the bot really stores:
 *   - every schema-registry model is catalogued under the collection name
 *     mongoose assigns it, and every collection a repository opens by name
 *     is catalogued too, so a new collection cannot silently show as
 *     "unregistered";
 *   - every catalogued collection has a label in both locales;
 *   - the schema flattening (`fieldsOfSchema`) and the name heuristics
 *     (`refKindFor`, `isTimestampName`) that decide how fields are filtered
 *     and rendered.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  INSPECT_CATALOG,
  fieldsOfSchema,
  isTimestampName,
  refKindFor,
} from '../../../src/persistence/inspect/catalog';
import { SCHEMAS } from '../../../src/persistence/schemas';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REPOSITORIES = join(REPO_ROOT, 'src', 'persistence', 'repositories');

const readLocale = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'i18n', 'locales', locale, 'replies.json'), 'utf8'),
  ) as Record<string, unknown>;

const labelsOf = (locale: string): Record<string, unknown> => {
  const section = readLocale(locale).db_inspect as { collections?: Record<string, unknown> };
  return section.collections ?? {};
};

/** Collection names that repositories open through the native driver. */
const rawCollectionNames = (): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const file of readdirSync(REPOSITORIES).filter((entry) => entry.endsWith('.ts'))) {
    const text = readFileSync(join(REPOSITORIES, file), 'utf8');
    for (const match of text.matchAll(/collection(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
};

describe('INSPECT_CATALOG coverage', () => {
  it('catalogs every schema-registry model under the collection name mongoose uses', () => {
    for (const [modelName, schema] of Object.entries(SCHEMAS)) {
      const collectionName = new mongoose.Mongoose().model(modelName, schema as Schema).collection
        .collectionName;
      const spec = INSPECT_CATALOG.get(collectionName);
      expect(spec, `${modelName} -> ${collectionName}`).toBeDefined();
      expect(spec?.fields, collectionName).toBeDefined();
    }
  });

  it('catalogs every collection a repository opens by name', () => {
    const names = rawCollectionNames();
    // Guard against the scan silently matching nothing after a refactor.
    expect(names.size).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(INSPECT_CATALOG.has(name), name).toBe(true);
  });

  it('catalogs the archive GC checkpoints, which are opened across a line break', () => {
    const source = readFileSync(join(REPOSITORIES, 'archive-reaction.repo.ts'), 'utf8');
    expect(source).toContain("'archive_gc_checkpoints'");
    expect(INSPECT_CATALOG.get('archive_gc_checkpoints')?.fields).toBeUndefined();
  });

  it('names a collection by its map key and leaves schemaless ones without fields', () => {
    for (const [name, spec] of INSPECT_CATALOG) expect(spec.name).toBe(name);
    expect(INSPECT_CATALOG.get('archive_schedule')?.fields).toBeUndefined();
    expect(INSPECT_CATALOG.get('messages')?.fields).toBeDefined();
  });

  it('labels every catalogued collection in both locales', () => {
    for (const locale of ['en', 'zh-TW']) {
      const labels = labelsOf(locale);
      for (const name of INSPECT_CATALOG.keys()) {
        const label = labels[name];
        expect(typeof label === 'string' && label.length > 0, `${locale}:${name}`).toBe(true);
      }
    }
  });

  it('only labels collections that are catalogued', () => {
    for (const locale of ['en', 'zh-TW']) {
      for (const name of Object.keys(labelsOf(locale))) {
        expect(INSPECT_CATALOG.has(name), `${locale}:${name}`).toBe(true);
      }
    }
  });

  it('summarises schema-backed collections with fields that exist', () => {
    for (const spec of INSPECT_CATALOG.values()) {
      if (spec.fields === undefined) continue;
      const paths = new Set(spec.fields.map((field) => field.path));
      for (const summary of spec.summaryFields) {
        expect(paths.has(summary), `${spec.name}.${summary}`).toBe(true);
      }
    }
  });
});

describe('fieldsOfSchema', () => {
  const fieldMap = (schema: Schema) =>
    new Map(fieldsOfSchema(schema).map((field) => [field.path, field]));

  it('flattens embedded subdocuments and keeps the parent as an object field', () => {
    const fields = fieldMap(SCHEMAS.Message as Schema);
    expect(fields.get('author')?.type).toBe('object');
    expect(fields.get('author.id')).toMatchObject({ type: 'string', ref: 'user' });
    expect(fields.get('reference.channelId')?.ref).toBe('channel');
    expect(fields.get('thread.id')?.ref).toBe('channel');
  });

  it('marks _id and the leading key of every index as indexed', () => {
    const fields = fieldMap(SCHEMAS.Message as Schema);
    expect(fields.get('_id')?.indexed).toBe(true);
    expect(fields.get('createdTimestamp')?.indexed).toBe(true);
    expect(fields.get('channelId')?.indexed).toBe(true);
    expect(fields.get('content')?.indexed).toBe(false);
  });

  it('types epoch-millisecond numbers as timestamp and other numbers as number', () => {
    const fields = fieldMap(SCHEMAS.Message as Schema);
    expect(fields.get('createdTimestamp')?.type).toBe('timestamp');
    expect(fields.get('type')?.type).toBe('number');
  });

  it('skips __v and the placeholder paths of Map fields', () => {
    const schema = new Schema({
      counters: { type: Map, of: new Schema({ at: Number }, { _id: false }) },
      title: String,
    });
    const paths = fieldsOfSchema(schema).map((field) => field.path);
    expect(paths).toContain('title');
    expect(paths).toContain('counters');
    expect(paths).not.toContain('__v');
    expect(paths.filter((path) => path.includes('$*'))).toEqual([]);
    expect(fieldsOfSchema(schema).find((field) => field.path === 'counters')?.type).toBe('object');
  });

  it('reports enum values, scalar types and arrays', () => {
    const schema = new Schema({
      state: { type: String, enum: ['open', 'closed'] },
      free: String,
      flag: Boolean,
      born: Date,
      owner_id: String,
      ref: Schema.Types.ObjectId,
      tags: [String],
      anything: Schema.Types.Mixed,
      price: Schema.Types.Decimal128,
    });
    const fields = fieldMap(schema);
    expect(fields.get('state')).toMatchObject({ type: 'string', enumValues: ['open', 'closed'] });
    expect(fields.get('free')).not.toHaveProperty('enumValues');
    expect(fields.get('free')).not.toHaveProperty('ref');
    expect(fields.get('flag')?.type).toBe('boolean');
    expect(fields.get('born')?.type).toBe('date');
    expect(fields.get('owner_id')?.ref).toBe('user');
    expect(fields.get('ref')?.type).toBe('objectId');
    expect(fields.get('tags')?.type).toBe('array');
    expect(fields.get('anything')?.type).toBe('mixed');
    expect(fields.get('price')?.type).toBe('number');
  });

  it('types a Number named like a time as timestamp', () => {
    const schema = new Schema({ expires_at: Number, count: Number });
    const fields = fieldMap(schema);
    expect(fields.get('expires_at')?.type).toBe('timestamp');
    expect(fields.get('count')?.type).toBe('number');
  });
});

describe('refKindFor', () => {
  it.each([
    ['role_id', 'role'],
    ['roleIds', 'role'],
    ['guildId', 'guild'],
    ['guild_id', 'guild'],
    ['channel_id', 'channel'],
    ['channelId', 'channel'],
    ['thread.id', 'channel'],
    ['thread_id', 'channel'],
    ['parentId', 'channel'],
    ['created_by', 'user'],
    ['participants', 'user'],
    ['author.id', 'user'],
    ['userId', 'user'],
    ['reference.authorId', 'user'],
    ['bot_id', 'user'],
    ['winners', 'user'],
  ] as const)('maps %s to %s', (path, kind) => {
    expect(refKindFor(path)).toBe(kind);
  });

  it.each(['message_id', 'reference.messageId', 'id', 'content', 'mentions.users'])(
    'does not guess an entity for %s',
    (path) => {
      expect(refKindFor(path)).toBeUndefined();
    },
  );
});

describe('isTimestampName', () => {
  it.each(['createdTimestamp', 'expires_at', 'observedAt', 'end_time', 'deadline', 'mutedUntil'])(
    'treats %s as epoch milliseconds',
    (path) => {
      expect(isTimestampName(path)).toBe(true);
    },
  );

  it.each(['content', 'percent', 'timestampNote', 'author.id'])('rejects %s', (path) => {
    expect(isTimestampName(path)).toBe(false);
  });
});
