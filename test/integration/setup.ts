/**
 * Vitest global setup for the integration project.
 *
 * Owns the lifecycle of a single in-memory MongoDB instance shared by
 * every integration suite. The URI is published via the
 * `INTEGRATION_MONGO_URI` environment variable; helpers in
 * `test/integration/helpers/mongo.ts` consume it to build per-test
 * mongoose connections.
 *
 * Why one server, not one per suite:
 *   - Spinning a fresh `MongoMemoryServer` costs 1.5–4 seconds
 *     (binary download + bootstrap). Sharing it keeps that cost to one
 *     start per run.
 *   - Per-test isolation comes from the helper layer instead: every
 *     connection gets its own uniquely named database, dropped when the
 *     test ends, so test files can run in parallel forks against the
 *     one server.
 *
 * The data directory lives on tmpfs when available; see
 * `test/support/tmpfs-db-path.ts` for why.
 *
 * Why `INTEGRATION_MONGO_URI` and not direct import:
 *   - vitest globalSetup runs in a separate worker scope; module-level
 *     state from this file is not visible to test files. An env var is
 *     the documented hand-off mechanism.
 */
import { rmSync } from 'node:fs';

import { MongoMemoryServer } from 'mongodb-memory-server';

import { createTmpfsDbPath } from '../support/tmpfs-db-path';

let server: MongoMemoryServer | undefined;
let tmpfsDbPath: string | undefined;

export const teardown = async (): Promise<void> => {
  try {
    if (server !== undefined) {
      await server.stop({ doCleanup: true, force: true });
      server = undefined;
    }
  } finally {
    // A caller-supplied dbPath is not the server's to delete.
    if (tmpfsDbPath !== undefined) {
      rmSync(tmpfsDbPath, { recursive: true, force: true });
      tmpfsDbPath = undefined;
    }
    delete process.env.INTEGRATION_MONGO_URI;
  }
};

export const setup = async (): Promise<void> => {
  tmpfsDbPath = createTmpfsDbPath();
  try {
    server = await MongoMemoryServer.create(
      tmpfsDbPath === undefined ? {} : { instance: { dbPath: tmpfsDbPath } },
    );
  } catch (error: unknown) {
    // Do not rely on vitest calling teardown after a failed setup; a
    // second call is harmless because teardown is idempotent.
    await teardown();
    throw error;
  }
  process.env.INTEGRATION_MONGO_URI = server.getUri();
};
