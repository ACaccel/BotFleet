/**
 * Server administration commands the archive needs. They read server state rather
 * than a collection, so they stay in the SDK boundary instead of a repository.
 */
import type { mongo } from 'mongoose';

/**
 * In-progress server operations of the client whose application name is
 * `applicationName`, or `undefined` when the server's answer cannot be read.
 * Lacking permission rejects; callers fail closed.
 */
export const clientOperations = async (
  db: mongo.Db,
  applicationName: string,
): Promise<readonly unknown[] | undefined> => {
  const active: unknown = await db
    .admin()
    .command({ currentOp: 1, $all: true, 'clientMetadata.application.name': applicationName });
  const operations = active as { inprog?: unknown };
  return Array.isArray(operations.inprog) ? operations.inprog : undefined;
};

/** The server's `storage.dbPath`, or `undefined` when it does not disclose one. */
export const serverDataPath = async (db: mongo.Db): Promise<string | undefined> => {
  const options: unknown = await db.admin().command({ getCmdLineOpts: 1 });
  const parsed = options as { parsed?: { storage?: { dbPath?: unknown } } };
  const dbPath = parsed.parsed?.storage?.dbPath;
  return typeof dbPath === 'string' && dbPath.length > 0 ? dbPath : undefined;
};
