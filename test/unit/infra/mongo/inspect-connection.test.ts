/** `/db` refuses any inspection account that could write. */
import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../../../src/core/errors';
import { writeCapableActions } from '../../../../src/infra/mongo/inspect-connection';

const status = (...grants: readonly (readonly string[])[]) => ({
  authInfo: {
    authenticatedUsers: [{ user: 'inspector', db: 'admin' }],
    authenticatedUserPrivileges: grants.map((actions) => ({
      resource: { db: '', collection: '' },
      actions,
    })),
  },
});

describe('writeCapableActions', () => {
  it('accepts the readAnyDatabase actions', () => {
    expect(
      writeCapableActions(
        status(
          ['find', 'listCollections', 'listIndexes', 'collStats', 'dbStats', 'killCursors'],
          ['listDatabases'],
        ),
      ),
    ).toEqual([]);
  });

  it('lists every action beyond read access once, sorted', () => {
    expect(
      writeCapableActions(status(['find', 'update', 'insert'], ['insert', 'dropDatabase'])),
    ).toEqual(['dropDatabase', 'insert', 'update']);
  });

  it('rejects a connection that is not authenticated', () => {
    expect(() =>
      writeCapableActions({
        authInfo: { authenticatedUsers: [], authenticatedUserPrivileges: [] },
      }),
    ).toThrow(ConfigurationError);
    expect(() => writeCapableActions({})).toThrow(ConfigurationError);
  });
});
