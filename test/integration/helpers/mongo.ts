/**
 * Mongoose connection helpers for integration suites.
 *
 * Each test should call `withFreshConnection(async (conn) => { ... })`
 * — the helper opens a mongoose connection to a database no other test
 * uses, runs the body, drops that database, and closes the connection.
 * Unique names are what let integration test files run in parallel
 * forks against the one shared memory-server without racing each
 * other's `dropDatabase` and index builds.
 */
import { randomBytes, randomInt } from 'node:crypto';

import mongoose, { type Connection } from 'mongoose';

const requireMongoUri = (): string => {
  const uri = process.env.INTEGRATION_MONGO_URI;
  if (uri === undefined || uri.length === 0) {
    throw new Error(
      'Integration helper: INTEGRATION_MONGO_URI is not set. ' +
        'Did vitest globalSetup at test/integration/setup.ts run?',
    );
  }
  return uri;
};

/**
 * The memory-server URI without its database path, the base that
 * `MongoConnectionManager` appends a guild id to.
 */
export const integrationMongoBaseUri = (): string => requireMongoUri().replace(/[^/]*$/, '');

/** A database name no other test uses (well under Mongo's 63-byte limit). */
const uniqueDbName = (): string => `it_${randomBytes(8).toString('hex')}`;

/**
 * A digit-only guild id no other test uses. `MongoConnectionManager`
 * names each guild's database after its id, so tests that drive the
 * production manager need unique ids for the same isolation
 * `withFreshConnection` gives everyone else.
 */
export const uniqueGuildId = (): string =>
  `9${Array.from({ length: 17 }, () => randomInt(10)).join('')}`;

export const withFreshConnection = async <T>(
  body: (connection: Connection) => Promise<T>,
): Promise<T> => {
  const connection = await mongoose
    .createConnection(requireMongoUri(), { dbName: uniqueDbName() })
    .asPromise();
  try {
    return await body(connection);
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
};

/**
 * Build something (typically a repository) on a live connection, then
 * close that connection before handing the result back. Calls on the
 * result fail inside the driver rather than in mongoose's casting
 * layer, which is the only way to exercise the real `DatabaseError`
 * classification path.
 */
export const withClosedConnection = <T>(
  build: (connection: Connection) => Promise<T>,
): Promise<T> => withFreshConnection(build);
