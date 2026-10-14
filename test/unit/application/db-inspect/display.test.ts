/** Stored documents render as plain JSON whatever driver types they hold. */
import { describe, expect, it } from 'vitest';

import { idString, toJson, toPlain, valueAt } from '../../../../src/application/db-inspect/display';

const objectId = { _bsontype: 'ObjectId', toString: () => '64b7f0c2a1b2c3d4e5f60718' };

describe('toPlain', () => {
  it('passes primitives through and stringifies bigints', () => {
    expect(toPlain(null)).toBeNull();
    expect(toPlain('a')).toBe('a');
    expect(toPlain(3)).toBe(3);
    expect(toPlain(10n)).toBe('10');
  });

  it('renders dates and driver values as strings', () => {
    expect(toPlain(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01T00:00:00.000Z');
    expect(toPlain(new Date(Number.NaN))).toBe('Invalid Date');
    expect(toPlain(objectId)).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(toPlain({ _bsontype: 'Long', toString: () => '9007199254740993' })).toBe(
      '9007199254740993',
    );
    expect(toPlain({ _bsontype: 'Binary', length: () => 4 })).toBe('<binary 4 bytes>');
    expect(toPlain(new Uint8Array(3))).toBe('<binary 3 bytes>');
  });

  it('walks arrays, maps and nested objects', () => {
    expect(
      toPlain({
        list: [objectId, 1],
        map: new Map([['k', objectId]]),
        nested: { at: new Date(0) },
      }),
    ).toEqual({
      list: ['64b7f0c2a1b2c3d4e5f60718', 1],
      map: { k: '64b7f0c2a1b2c3d4e5f60718' },
      nested: { at: '1970-01-01T00:00:00.000Z' },
    });
  });
});

describe('document helpers', () => {
  it('formats JSON and IDs', () => {
    expect(toJson({ _id: objectId, a: 1 })).toBe(
      '{\n  "_id": "64b7f0c2a1b2c3d4e5f60718",\n  "a": 1\n}',
    );
    expect(idString({ _id: objectId })).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(idString({ _id: '123' })).toBe('123');
    expect(idString({ _id: { a: 1 } })).toBe('{"a":1}');
  });

  it('reads dotted paths through objects and maps', () => {
    const document = { author: { id: '1' }, gens: new Map([['x', { n: 2 }]]), flat: 'v' };
    expect(valueAt(document, 'author.id')).toBe('1');
    expect(valueAt(document, 'gens.x.n')).toBe(2);
    expect(valueAt(document, 'flat.deeper')).toBeUndefined();
    expect(valueAt(document, 'missing.path')).toBeUndefined();
  });
});
