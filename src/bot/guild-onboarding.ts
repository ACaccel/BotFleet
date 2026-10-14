/**
 * Guild-onboarding port implementation.
 *
 * Supplies the concrete, `BaseBot`-backed implementation of the
 * `GuildOnboardingPort` contract (`core/plugin/guild-onboarding-port.ts`).
 * It lives in `src/bot/` because only the composition root may depend on
 * `BaseBot` internals (`connectOneGuild`, `commandHandlers`,
 * `registerGuildSlotInternal`, `getRepos`).
 *
 * `BaseBot` registers an instance under `TOKENS.GuildOnboardingPort`, and
 * the `guild-events` plugin resolves and invokes it from its `guildCreate`
 * subscription, so no plugin code touches `BaseBot` directly.
 */
import type { Guild } from 'discord.js';

import type {
  GuildOnboardingPort,
  GuildOnboardingResult,
} from '../core/plugin/guild-onboarding-port';
import { logError, logSystem, ops } from '../core/logger';
import { getCommandJsonBody } from '@cmd';

import type { BaseBot, GuildInfo } from './index';

/**
 * `BaseBot`-backed {@link GuildOnboardingPort}.
 *
 * The implementation is intentionally a thin Adapter over `BaseBot`:
 * it owns no state of its own and reads everything it needs from the
 * bot at call time, so it stays correct across the bot's whole
 * lifecycle (e.g. `commandHandlers` populated only after
 * `registerCommands` runs during `clientReady`).
 */
export class BaseBotGuildOnboardingPort implements GuildOnboardingPort {
  /**
   * @param bot - the composition-root bot whose internals the port
   *   adapts. Held by reference so the port observes the bot's live
   *   `guildInfo` / `commandHandlers` state.
   */
  public constructor(private readonly bot: BaseBot) {}

  /**
   * Onboard a freshly joined guild: initialise its `guildInfo` slot,
   * open its per-guild database connection, and register the bot's
   * slash commands for it.
   *
   * A failed database connection is re-thrown — the guild cannot
   * function without it. A failed command registration is caught and
   * logged: a Discord API hiccup there must not abort onboarding (the
   * commands re-sync on the next deploy / restart).
   *
   * @param guildId - the Discord snowflake of the newly joined guild.
   * @returns a {@link GuildOnboardingResult} describing what succeeded.
   * @throws when the per-guild database connection cannot be opened.
   */
  public async onboardGuild(guildId: string): Promise<GuildOnboardingResult> {
    const bot = this.bot;
    const guild = bot.client.guilds.cache.get(guildId);
    if (guild === undefined) {
      // A `guildCreate` event always carries a cached guild, so a
      // missing entry here is a contract violation by the caller,
      // not a runtime/domain failure — surface it as TypeError.
      throw new TypeError(
        `BaseBotGuildOnboardingPort.onboardGuild: guild ${guildId} is not in the client cache.`,
      );
    }

    this.initialiseGuildInfoSlot(guild);
    const databaseConnected = await this.connectDatabase(guildId);
    const commandsRegistered = await this.registerGuildCommands(guildId);

    logSystem(bot.logger, `Bot added to guild: ${guild.name} (${guildId})`);
    return { guildId, databaseConnected, commandsRegistered };
  }

  /**
   * Create the bot's `guildInfo` slot for a new guild: empty channel
   * / role maps, with `bot_name` populated from the member cache.
   */
  private initialiseGuildInfoSlot(guild: Guild): void {
    const slot: GuildInfo = {
      bot_name: guild.members.cache.get(this.bot.clientId)?.displayName ?? '',
      guild,
      channels: {},
      roles: {},
    };
    this.bot.registerGuildSlotInternal(guild.id, slot);
  }

  /**
   * Open the per-guild database connection via `connectOneGuild`.
   * Re-throws on failure: the guild is unusable without its database.
   */
  private async connectDatabase(guildId: string): Promise<boolean> {
    const mongoURI = this.bot.getMongoURI();
    // A bot built without Mongo gets either `undefined` or the
    // empty-string fallback (`env.MONGO_URI ?? ''`) — treat both as
    // "no database configured", a deployment choice rather than a
    // per-guild failure.
    if (mongoURI === undefined || mongoURI.length === 0) {
      return false;
    }
    await this.bot.connectOneGuild(guildId);
    return this.bot.getRepos(guildId) !== undefined;
  }

  /**
   * Register the bot's slash commands against the new guild. Failures
   * are caught and logged — a Discord API error here must not abort
   * onboarding.
   *
   * The Discord call is awaited so the returned
   * `commandsRegistered` reports what actually happened. The previous
   * fire-and-forget form always returned `true`, so the caller's
   * result — and the `guildCreate` log line built from it — claimed
   * success for every rejected registration.
   */
  private async registerGuildCommands(guildId: string): Promise<boolean> {
    const bot = this.bot;
    const application = bot.client.application;
    if (application === null || application === undefined) {
      logSystem(bot.logger, 'Skipped guild command registration: client application is not ready.');
      return false;
    }
    const restCommands = getCommandJsonBody(bot.commandHandlers, bot);
    try {
      await application.commands.set(restCommands, guildId);
      return true;
    } catch (err: unknown) {
      logError(
        bot.logger,
        guildId,
        new Error(ops.command.guildSyncFailed(guildId), { cause: err }),
      );
      return false;
    }
  }
}
