/**
 * The read-only server connection behind nijika's `/db` inspection.
 *
 * Separate from {@link MongoConnectionManager}: opening a guild through the
 * manager registers models and builds indexes, which writes, and would create
 * a database for a guild that has none. This client only reads, and refuses to
 * open unless its account is limited to read actions.
 */
import mongoose, { type mongo } from 'mongoose';

import { ConfigurationError } from '../../core/errors';

/**
 * Actions of the built-in `read` / `readAnyDatabase` roles plus read-only
 * statistics. Any other granted action rejects the account, so a role that
 * can write never reaches the inspection commands.
 */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'changeStream',
  'collStats',
  'dbHash',
  'dbStats',
  'find',
  'indexStats',
  'killCursors',
  'listCollections',
  'listDatabases',
  'listIndexes',
  'listSearchIndexes',
  'planCacheRead',
]);

/** Databases that hold guild data are named by the guild's snowflake. */
const GUILD_DATABASE_NAME = /^\d+$/;

interface PrivilegeGrant {
  readonly actions?: readonly unknown[];
}

interface ConnectionStatus {
  readonly authInfo?: {
    readonly authenticatedUsers?: readonly unknown[];
    readonly authenticatedUserPrivileges?: readonly PrivilegeGrant[];
  };
}

/** One guild database on the server. */
interface GuildDatabaseInfo {
  readonly name: string;
  readonly sizeOnDisk: number;
}

export interface InspectConnection {
  /** Guild databases on the server, by name. */
  listGuildDatabases(): Promise<readonly GuildDatabaseInfo[]>;
  /** A guild database handle; throws for a name that is not a guild ID. */
  database(name: string): mongo.Db;
  close(): Promise<void>;
}

/**
 * The actions an authenticated account holds beyond read access, sorted.
 * Throws when the connection is not authenticated: without access control
 * every action is allowed, so read-only cannot be verified.
 */
export const writeCapableActions = (status: unknown): readonly string[] => {
  const authInfo = (status as ConnectionStatus).authInfo;
  if ((authInfo?.authenticatedUsers?.length ?? 0) === 0) {
    throw new ConfigurationError({
      code: 'INVALID_ENV',
      messageKey: 'errors:bot.inspect_account_invalid',
      context: { operation: 'writeCapableActions', input: { variable: 'MONGO_INSPECT_URI' } },
      cause: new Error('MONGO_INSPECT_URI must authenticate as a dedicated read-only user'),
    });
  }
  const extra = new Set<string>();
  for (const grant of authInfo?.authenticatedUserPrivileges ?? []) {
    for (const action of grant.actions ?? []) {
      const name = String(action);
      if (!READ_ONLY_ACTIONS.has(name)) extra.add(name);
    }
  }
  return [...extra].sort();
};

const readOnlyAccountError = (actions: readonly string[]): ConfigurationError =>
  new ConfigurationError({
    code: 'INVALID_ENV',
    messageKey: 'errors:bot.inspect_account_invalid',
    context: { operation: 'openInspectConnection', input: { variable: 'MONGO_INSPECT_URI' } },
    cause: new Error(
      `MONGO_INSPECT_URI must use a read-only account; it also grants: ${actions.join(', ')}`,
    ),
  });

const requireGuildDatabaseName = (name: string): string => {
  if (!GUILD_DATABASE_NAME.test(name)) {
    throw new TypeError(`not a guild database name: "${name}"`);
  }
  return name;
};

/** Open the inspection client and verify that its account cannot write. */
export const openInspectConnection = async (uri: string): Promise<InspectConnection> => {
  const client = new mongoose.mongo.MongoClient(uri, {
    appName: 'botfleet-db-inspect',
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  try {
    const status: unknown = await client
      .db('admin')
      .command({ connectionStatus: 1, showPrivileges: true });
    const extra = writeCapableActions(status);
    if (extra.length > 0) throw readOnlyAccountError(extra);
  } catch (error) {
    await client.close();
    throw error;
  }
  return inspectConnectionFor(client);
};

/**
 * Wrap an already connected client. {@link openInspectConnection} is the
 * production path; integration tests use this against an unauthenticated
 * memory server.
 */
export const inspectConnectionFor = (client: mongo.MongoClient): InspectConnection => ({
  async listGuildDatabases() {
    const result = await client.db('admin').admin().listDatabases({ nameOnly: false });
    return result.databases
      .filter((entry) => GUILD_DATABASE_NAME.test(entry.name))
      .map((entry) => ({ name: entry.name, sizeOnDisk: entry.sizeOnDisk ?? 0 }));
  },
  database: (name) => client.db(requireGuildDatabaseName(name)),
  close: () => client.close(),
});
