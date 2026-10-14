/**
 * `openInspectConnection` keeps a client only when its account is read-only,
 * and closes it otherwise. The driver client is replaced, since the memory
 * server used by integration tests has no authentication.
 */
/* eslint-disable import/first */
import type * as MongooseModule from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: {} as unknown,
  closed: 0,
  options: undefined as unknown,
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof MongooseModule>();
  class FakeMongoClient {
    public constructor(_uri: string, options: unknown) {
      state.options = options;
    }
    public async connect(): Promise<void> {}
    public async close(): Promise<void> {
      state.closed += 1;
    }
    public db(name: string) {
      return {
        databaseName: name,
        command: async () => state.status,
        admin: () => ({
          listDatabases: async () => ({
            databases: [
              { name: '123456789012345678', sizeOnDisk: 8 },
              { name: 'admin', sizeOnDisk: 1 },
              { name: '987654321098765432' },
            ],
          }),
        }),
      };
    }
  }
  return {
    ...actual,
    default: {
      ...actual.default,
      mongo: { ...actual.default.mongo, MongoClient: FakeMongoClient },
    },
  };
});

import { ConfigurationError } from '../../../../src/core/errors';
import { openInspectConnection } from '../../../../src/infra/mongo/inspect-connection';

const authenticated = (actions: readonly string[]) => ({
  authInfo: {
    authenticatedUsers: [{ user: 'inspector', db: 'admin' }],
    authenticatedUserPrivileges: [{ resource: { db: '', collection: '' }, actions }],
  },
});

beforeEach(() => {
  state.closed = 0;
});

describe('openInspectConnection', () => {
  it('returns a connection for a read-only account', async () => {
    state.status = authenticated(['find', 'listDatabases']);
    const connection = await openInspectConnection('mongodb://inspector@db.example.com');
    expect(state.options).toMatchObject({ appName: 'botfleet-db-inspect' });
    expect(state.closed).toBe(0);
    expect(await connection.listGuildDatabases()).toEqual([
      { name: '123456789012345678', sizeOnDisk: 8 },
      { name: '987654321098765432', sizeOnDisk: 0 },
    ]);
    expect(connection.database('123456789012345678').databaseName).toBe('123456789012345678');
    expect(() => connection.database('admin')).toThrow(TypeError);
    await connection.close();
    expect(state.closed).toBe(1);
  });

  it('closes the client and names the extra actions of a write-capable account', async () => {
    state.status = authenticated(['find', 'insert', 'update']);
    const failure = await openInspectConnection('mongodb://writer@db.example.com').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(String((failure as ConfigurationError).cause)).toContain('insert, update');
    expect(state.closed).toBe(1);
  });
});
