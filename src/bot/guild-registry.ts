/**
 * GuildRegistry — typed, read-only view of per-guild runtime state that
 * plugins query without holding a reference to BaseBot itself.
 *
 * Lives beside {@link TOKENS} because the contract names a `discord.js`
 * type and the persistence layer's `Repos` bundle. Plugins import it from
 * `src/bot/`; the `BaseBot` class itself stays off-limits to them
 * (enforced by `no-restricted-imports`).
 *
 * The IoC container exposes only a typed resolver, not the BaseBot
 * instance, so plugins reach repos and configured channels by guild id
 * through this narrow surface (`getRepos`, `getChannel`, `getRole`,
 * `listGuildIds`). BaseBot mutates the underlying map; plugins MUST NOT
 * cast to the concrete impl to mutate state.
 */
import type { Channel, Role } from 'discord.js';

import type { Repos } from '../persistence/repositories';

export interface GuildRegistry {
  /** Repos bag for `guildId`, or `undefined` when the guild has no DB hookup yet. */
  getRepos(guildId: string): Repos | undefined;
  /**
   * Configured channel by symbolic name (e.g. `'event'`, `'debug'`,
   * `'earthquake'`). Returns `undefined` when the guild config omits
   * the slot or the channel id no longer resolves to a cached channel.
   */
  getChannel(guildId: string, name: string): Channel | undefined;
  /** Configured role by symbolic name. Same semantics as `getChannel`. */
  getRole(guildId: string, name: string): Role | undefined;
  /** Snapshot of currently-known guild ids. */
  listGuildIds(): readonly string[];
}
