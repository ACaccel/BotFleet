/**
 * `/db` filters are three structured choices. Pins which operators each
 * field type offers, how values are converted, and that nothing typed is
 * ever turned into query syntax.
 */
import { describe, expect, it } from 'vitest';

import {
  inferFields,
  operatorsFor,
  parseFilter,
} from '../../../../src/application/db-inspect/fields';
import { DbInspectError } from '../../../../src/core/errors';
import type { InspectField } from '../../../../src/persistence/inspect/catalog';
import type { InspectCondition } from '../../../../src/persistence/repositories/db-inspect.repo';

const FIELDS: readonly InspectField[] = [
  { path: '_id', type: 'objectId', indexed: true },
  { path: 'name', type: 'string', indexed: false },
  { path: 'count', type: 'number', indexed: false },
  { path: 'createdAt', type: 'timestamp', indexed: true },
  { path: 'expires', type: 'date', indexed: false },
  { path: 'active', type: 'boolean', indexed: false },
  { path: 'status', type: 'string', indexed: false, enumValues: ['open', 'closed'] },
  { path: 'members', type: 'array', indexed: false },
  { path: 'meta', type: 'object', indexed: false },
];

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof DbInspectError ? error.code : 'OTHER';
  }
  return undefined;
};

const parse = (field: string, operator: string, value: string): InspectCondition => {
  const condition = parseFilter(FIELDS, { field, operator, value });
  if (condition === undefined) throw new Error('expected a condition');
  return condition;
};

describe('operatorsFor', () => {
  it('offers operators by type and exact values for an enum', () => {
    const byPath = (path: string) => FIELDS.find((field) => field.path === path)!;
    expect(operatorsFor(byPath('name'))).toEqual(['eq', 'contains', 'exists']);
    expect(operatorsFor(byPath('createdAt'))).toEqual(['eq', 'gt', 'lt', 'exists']);
    expect(operatorsFor(byPath('members'))).toEqual(['contains', 'exists']);
    expect(operatorsFor(byPath('meta'))).toEqual(['exists']);
    expect(operatorsFor(byPath('status'))).toEqual(['eq', 'exists']);
  });
});

describe('parseFilter', () => {
  it('returns no condition when no part is given', () => {
    expect(parseFilter(FIELDS, {})).toBeUndefined();
    expect(parseFilter(FIELDS, { field: '', operator: '', value: '' })).toBeUndefined();
  });

  it('rejects a filter with only some parts', () => {
    expect(codeOf(() => parseFilter(FIELDS, { field: 'name', value: 'x' }))).toBe(
      'DB_INSPECT_PARTIAL_FILTER',
    );
  });

  it('rejects an unknown field and an operator the field does not take', () => {
    expect(codeOf(() => parse('missing', 'eq', 'x'))).toBe('DB_INSPECT_UNKNOWN_FIELD');
    expect(codeOf(() => parse('count', 'contains', '1'))).toBe('DB_INSPECT_INVALID_OPERATOR');
    expect(codeOf(() => parse('name', 'regex', 'x'))).toBe('DB_INSPECT_INVALID_OPERATOR');
  });

  it('keeps string values literal, query syntax included', () => {
    expect(parse('name', 'eq', '{"$ne":null}')).toEqual({
      field: 'name',
      operator: 'eq',
      value: '{"$ne":null}',
    });
    expect(parse('name', 'contains', '.*')).toEqual({
      field: 'name',
      operator: 'substring',
      value: '.*',
    });
  });

  it('matches array elements for contains', () => {
    expect(parse('members', 'contains', '123')).toEqual({
      field: 'members',
      operator: 'eq',
      value: '123',
    });
  });

  it('rejects values over the length limit', () => {
    expect(codeOf(() => parse('name', 'eq', 'x'.repeat(101)))).toBe('DB_INSPECT_INVALID_VALUE');
  });

  it('converts ObjectIds, numbers and booleans by field type', () => {
    expect(parse('_id', 'eq', ' 64b7f0c2a1b2c3d4e5f60718 ').value).toEqual({
      objectId: '64b7f0c2a1b2c3d4e5f60718',
    });
    expect(codeOf(() => parse('_id', 'eq', 'nope'))).toBe('DB_INSPECT_INVALID_VALUE');
    expect(parse('count', 'gt', '42').value).toBe(42);
    expect(codeOf(() => parse('count', 'eq', 'abc'))).toBe('DB_INSPECT_INVALID_VALUE');
    expect(codeOf(() => parse('count', 'eq', ' '))).toBe('DB_INSPECT_INVALID_VALUE');
    expect(parse('active', 'eq', 'TRUE').value).toBe(true);
    expect(parse('active', 'eq', 'false').value).toBe(false);
    expect(codeOf(() => parse('active', 'eq', 'yes'))).toBe('DB_INSPECT_INVALID_VALUE');
  });

  it('reads times as epoch milliseconds or dates', () => {
    expect(parse('createdAt', 'lt', '1700000000000').value).toBe(1_700_000_000_000);
    expect(parse('createdAt', 'gt', '2026-01-02').value).toBe(Date.UTC(2026, 0, 2));
    expect(codeOf(() => parse('createdAt', 'gt', 'yesterday'))).toBe('DB_INSPECT_INVALID_VALUE');
    expect(parse('expires', 'lt', '2026-01-02T03:04:05Z').value).toEqual(
      new Date('2026-01-02T03:04:05Z'),
    );
  });

  it('accepts only declared enum values', () => {
    expect(parse('status', 'eq', 'open').value).toBe('open');
    expect(codeOf(() => parse('status', 'eq', 'pending'))).toBe('DB_INSPECT_INVALID_VALUE');
  });

  it('reads exists as a boolean on any field', () => {
    expect(parse('meta', 'exists', 'false')).toEqual({
      field: 'meta',
      operator: 'exists',
      value: false,
    });
    expect(codeOf(() => parse('meta', 'exists', 'maybe'))).toBe('DB_INSPECT_INVALID_VALUE');
  });
});

describe('inferFields', () => {
  it('types top-level fields from documents and marks indexes', () => {
    const objectId = { _bsontype: 'ObjectId', toString: () => 'abc' };
    const fields = inferFields(
      [
        { _id: objectId, name: 'a', observedAt: 1, tags: ['x'], meta: { a: 1 }, flag: true },
        { _id: objectId, name: 'b', observedAt: 2, mixed: 1, when: new Date(0), userId: null },
        { _id: objectId, name: null, mixed: 'one', userId: '123' },
      ],
      new Set(['name']),
    );
    const byPath = Object.fromEntries(fields.map((field) => [field.path, field]));
    expect(fields[0]?.path).toBe('_id');
    expect(byPath['_id']).toEqual({ path: '_id', type: 'objectId', indexed: true });
    expect(byPath['name']).toEqual({ path: 'name', type: 'string', indexed: true });
    expect(byPath['observedAt']?.type).toBe('timestamp');
    expect(byPath['tags']?.type).toBe('array');
    expect(byPath['meta']?.type).toBe('object');
    expect(byPath['flag']?.type).toBe('boolean');
    expect(byPath['when']?.type).toBe('date');
    expect(byPath['mixed']?.type).toBe('mixed');
    expect(byPath['userId']).toEqual({
      path: 'userId',
      type: 'string',
      indexed: false,
      ref: 'user',
    });
    expect(fields.map((field) => field.path).slice(1)).toEqual(
      [...fields.map((field) => field.path).slice(1)].sort(),
    );
  });

  it('reports a field seen only as null as mixed', () => {
    expect(inferFields([{ empty: null, count: 3 }], new Set())).toEqual([
      { path: 'count', type: 'number', indexed: false },
      { path: 'empty', type: 'mixed', indexed: false },
    ]);
  });
});
