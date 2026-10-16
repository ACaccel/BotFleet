import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../../../src/core/errors';
import {
  databaseErrorFrom,
  isTransient,
  __classifyMongoErrorForTests as classify,
} from '../../../src/persistence/error-translator';

describe('classifyMongoError', () => {
  it('maps the well-known duplicate-key code 11000', () => {
    expect(classify({ code: 11000, message: 'E11000 duplicate key' })).toBe(
      'DATABASE_DUPLICATE_KEY',
    );
    expect(classify({ code: '11000' })).toBe('DATABASE_DUPLICATE_KEY');
  });

  it('maps mongoose ValidationError / CastError', () => {
    expect(classify({ name: 'ValidationError', message: 'bad' })).toBe('DATABASE_VALIDATION');
    expect(classify({ name: 'CastError', message: 'bad' })).toBe('DATABASE_VALIDATION');
  });

  it('maps server-selection / timeout shapes', () => {
    expect(classify({ name: 'MongooseServerSelectionError' })).toBe('DATABASE_TIMEOUT');
    expect(classify({ name: 'MongoServerSelectionError' })).toBe('DATABASE_TIMEOUT');
    expect(classify({ name: 'MongoNetworkTimeoutError' })).toBe('DATABASE_TIMEOUT');
    expect(classify({ message: 'operation timed out after 5s' })).toBe('DATABASE_TIMEOUT');
  });

  it('maps an exceeded maxTimeMS to QUERY_TIMEOUT, ahead of the generic timeout patterns', () => {
    expect(
      classify({ name: 'MongoServerError', code: 50, message: 'operation exceeded time limit' }),
    ).toBe('DATABASE_QUERY_TIMEOUT');
    expect(classify({ codeName: 'MaxTimeMSExpired', message: 'query timeout' })).toBe(
      'DATABASE_QUERY_TIMEOUT',
    );
  });

  it('maps non-timeout network failures', () => {
    expect(classify({ name: 'MongoNetworkError' })).toBe('DATABASE_NETWORK');
    expect(classify({ message: 'connect ECONNREFUSED 127.0.0.1:27017' })).toBe('DATABASE_NETWORK');
    expect(classify({ message: 'getaddrinfo ENOTFOUND host' })).toBe('DATABASE_NETWORK');
  });

  it('falls back to UNKNOWN for anything unrecognised, including non-object input', () => {
    expect(classify(null)).toBe('DATABASE_UNKNOWN');
    expect(classify(undefined)).toBe('DATABASE_UNKNOWN');
    expect(classify('plain string')).toBe('DATABASE_UNKNOWN');
    expect(classify({ name: 'SomethingWeird', message: 'meh' })).toBe('DATABASE_UNKNOWN');
  });
});

describe('databaseErrorFrom', () => {
  it('returns a DatabaseError with the classified sub-code', () => {
    const raw = new Error('E11000 duplicate key');
    (raw as Error & { code: number }).code = 11000;
    const out = databaseErrorFrom(raw, { operation: 'MongoMessageRepo.insertOne' });
    expect(out).toBeInstanceOf(DatabaseError);
    expect(out.code).toBe('DATABASE_DUPLICATE_KEY');
    expect(out.messageKey).toBe('errors:db.duplicate_key');
    expect(out.context.operation).toBe('MongoMessageRepo.insertOne');
    expect(out.cause).toBe(raw);
  });

  it('produces an i18next-style errors:db.* messageKey for every sub-code', () => {
    // The key must use the `namespace:key.path` colon convention so the
    // handler boundary can resolve it; the `.`-separated form silently
    // missed the catalog.
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [
        (() => {
          const e = new Error('E11000 duplicate key');
          (e as Error & { code: number }).code = 11000;
          return e;
        })(),
        'errors:db.duplicate_key',
      ],
      [{ name: 'MongooseServerSelectionError' }, 'errors:db.timeout'],
      [{ code: 50 }, 'errors:db.query_timeout'],
      [{ name: 'MongoNetworkError' }, 'errors:db.network'],
      [{ name: 'ValidationError', message: 'bad' }, 'errors:db.validation'],
      [{ name: 'SomethingWeird' }, 'errors:db.unavailable'],
    ];
    for (const [raw, expectedKey] of cases) {
      const out = databaseErrorFrom(raw, { operation: 'MongoMessageRepo.run' });
      expect(out.messageKey).toBe(expectedKey);
      expect(out.messageKey.startsWith('errors:db.')).toBe(true);
    }
  });

  it('threads context.input through unchanged', () => {
    const out = databaseErrorFrom(new Error('timed out'), {
      operation: 'MongoMessageRepo.findOne',
      input: { messageId: 'm1' },
    });
    expect(out.code).toBe('DATABASE_TIMEOUT');
    expect(out.context.input).toEqual({ messageId: 'm1' });
  });
});

describe('isTransient', () => {
  const errorWith = (raw: unknown): DatabaseError =>
    databaseErrorFrom(raw, { operation: 'MongoConnectionManager.open' });

  it('treats timeout and network failures as transient (retry-eligible)', () => {
    expect(isTransient(errorWith({ name: 'MongooseServerSelectionError' }))).toBe(true);
    expect(isTransient(errorWith({ name: 'MongoNetworkTimeoutError' }))).toBe(true);
    expect(isTransient(errorWith({ message: 'operation timed out after 5s' }))).toBe(true);
    expect(isTransient(errorWith({ name: 'MongoNetworkError' }))).toBe(true);
    expect(isTransient(errorWith({ message: 'connect ECONNREFUSED 127.0.0.1:27017' }))).toBe(true);
  });

  it('treats duplicate-key, validation, query-timeout and unknown failures as persistent', () => {
    expect(isTransient(errorWith({ code: 11000 }))).toBe(false);
    expect(isTransient(errorWith({ name: 'ValidationError', message: 'bad' }))).toBe(false);
    expect(isTransient(errorWith({ name: 'CastError', message: 'bad' }))).toBe(false);
    expect(isTransient(errorWith({ name: 'SomethingWeird' }))).toBe(false);
    expect(isTransient(errorWith({ code: 50, message: 'operation exceeded time limit' }))).toBe(
      false,
    );
    expect(isTransient(errorWith(null))).toBe(false);
  });
});
