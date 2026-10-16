/** `/db list` sessions expire, belong to one member, and are bounded in number. */
import { describe, expect, it } from 'vitest';

import {
  QuerySessionStore,
  SESSION_TTL_MS,
  type NewQuerySession,
} from '../../../../src/application/db-inspect/session-store';
import { DbInspectError } from '../../../../src/core/errors';

const input: NewQuerySession = {
  userId: 'admin',
  database: '111111111111111111',
  collection: 'replies',
  sort: { field: '_id', direction: -1 },
  total: { count: 3, capped: false },
  unindexedFilter: false,
  fields: [],
  summaryFields: [],
};

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof DbInspectError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('QuerySessionStore', () => {
  it('issues short URL-safe tokens and returns the session to its owner', () => {
    const store = new QuerySessionStore(() => 0);
    const session = store.create(input);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(session.pageIds).toEqual([]);
    expect(store.require(session.token, 'admin')).toBe(session);
  });

  it('refuses another member', () => {
    const store = new QuerySessionStore(() => 0);
    const { token } = store.create(input);
    expect(codeOf(() => store.require(token, 'someone-else'))).toBe('DB_INSPECT_NOT_INVOKER');
  });

  it('expires after the TTL, and each use extends it', () => {
    let now = 0;
    const store = new QuerySessionStore(() => now);
    const { token } = store.create(input);
    now = SESSION_TTL_MS - 1;
    store.require(token, 'admin');
    now += SESSION_TTL_MS - 1;
    expect(store.require(token, 'admin').token).toBe(token);
    now += SESSION_TTL_MS;
    expect(codeOf(() => store.require(token, 'admin'))).toBe('DB_INSPECT_SESSION_EXPIRED');
    expect(codeOf(() => store.require('unknown', 'admin'))).toBe('DB_INSPECT_SESSION_EXPIRED');
  });

  it('drops the oldest session beyond its capacity', () => {
    const store = new QuerySessionStore(() => 0);
    const first = store.create(input);
    for (let i = 0; i < 200; i += 1) store.create(input);
    expect(codeOf(() => store.require(first.token, 'admin'))).toBe('DB_INSPECT_SESSION_EXPIRED');
  });

  it('prunes expired sessions when creating new ones', () => {
    let now = 0;
    const store = new QuerySessionStore(() => now);
    const stale = store.create(input);
    now = SESSION_TTL_MS + 1;
    const fresh = store.create(input);
    expect(codeOf(() => store.require(stale.token, 'admin'))).toBe('DB_INSPECT_SESSION_EXPIRED');
    expect(store.require(fresh.token, 'admin')).toBe(fresh);
  });
});
