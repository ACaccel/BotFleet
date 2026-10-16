/**
 * DbInspectPlugin — opens the read-only inspection client behind nijika's
 * `/db` and publishes the service the command reads through
 * `BaseBot.dbInspectService`.
 *
 * Opening verifies that the account can only read. A failure disables this
 * plugin, which withholds the readiness marker, and `/db` answers that it
 * is unavailable; it never runs on an account that could write.
 */
import type { Client } from 'discord.js';

import { TOKENS } from '../../bot/tokens';
import type { Plugin } from '../../core/plugin';
import { DbInspectService, type DiscordDirectory } from '../../application/db-inspect/service';
import {
  openInspectConnection,
  type InspectConnection,
} from '../../infra/mongo/inspect-connection';
import { MongoDbInspectRepo } from '../../persistence/repositories/db-inspect.repo';

const PLUGIN_ID = 'db-inspect';
const PLUGIN_VERSION = '1.0.0';

/** Names from the client cache; users not cached are fetched only when asked. */
export const discordDirectoryFor = (client: Client): DiscordDirectory => ({
  guildName: (guildId) => client.guilds.cache.get(guildId)?.name,
  channelName: (channelId) => {
    const channel = client.channels.cache.get(channelId);
    return channel !== undefined && 'name' in channel && typeof channel.name === 'string'
      ? channel.name
      : undefined;
  },
  roleName: (guildId, roleId) => client.guilds.cache.get(guildId)?.roles.cache.get(roleId)?.name,
  userName: async (userId, fetch) => {
    const cached = client.users.cache.get(userId);
    if (cached !== undefined) return cached.username;
    if (!fetch) return undefined;
    try {
      return (await client.users.fetch(userId)).username;
    } catch {
      return undefined;
    }
  },
});

export interface DbInspectPluginOptions {
  /** `MONGO_INSPECT_URI`; the composition root requires it before registering the plugin. */
  readonly uri: string;
  /** Test seam for the server connection. */
  readonly open?: (uri: string) => Promise<InspectConnection>;
}

export const createDbInspectPlugin = (options: DbInspectPluginOptions): Plugin => {
  let connection: InspectConnection | undefined;
  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    async init(ctx) {
      const open = options.open ?? openInspectConnection;
      const opened = await open(options.uri);
      connection = opened;
      const service = new DbInspectService({
        listGuildDatabases: () => opened.listGuildDatabases(),
        repo: (database, maxTimeMS) => new MongoDbInspectRepo(opened.database(database), maxTimeMS),
        directory: discordDirectoryFor(ctx.resolve(TOKENS.DiscordClient)),
        logger: ctx.logger,
        now: () => ctx.clock.now(),
      });
      ctx.registerInstance(TOKENS.DbInspectService, service);
    },
    async onShutdown() {
      await connection?.close();
      connection = undefined;
    },
  };
};
