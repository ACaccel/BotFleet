import type { Channel } from 'discord.js';
import type { Repos } from '../persistence/repositories';

/**
 * The per-guild lookups a feature service needs, narrowed to the repositories
 * it uses. The composition root's `GuildRegistry` satisfies it, so plugins pass
 * `TOKENS.GuildRegistry` and handlers pass `BaseBot.guildRegistry` unchanged.
 */
export interface GuildLookup<K extends keyof Repos> {
  /** The guild's repositories, or `undefined` before its database is connected. */
  getRepos(guildId: string): Pick<Repos, K> | undefined;
  /** A configured channel by symbolic name, such as `'debug'`. */
  getChannel(guildId: string, name: string): Channel | undefined;
  listGuildIds(): readonly string[];
}
