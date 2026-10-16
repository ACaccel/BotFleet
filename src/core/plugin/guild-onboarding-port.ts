/**
 * Guild-onboarding port.
 *
 * When a bot is added to a new Discord guild, two infrastructure
 * actions must happen before the guild is usable: its per-guild Mongo
 * database must be connected, and the bot's slash commands must be
 * registered against that guild.
 *
 * This port is the typed seam between the plugin layer and those actions.
 * The composition root (`BaseBot`) registers the implementation under
 * {@link TOKENS.GuildOnboardingPort}; the `guild-events` plugin resolves it
 * via `ctx.resolve` from its `guildCreate` subscription.
 *
 * The contract uses only primitive / string types, so `core/plugin` gains
 * no dependency on `persistence` or `infra`.
 */

/** Outcome of onboarding a single new guild. */
export interface GuildOnboardingResult {
  /** The guild that was onboarded. */
  readonly guildId: string;
  /** True when the per-guild database connection succeeded. */
  readonly databaseConnected: boolean;
  /** True when slash commands were registered for the guild. */
  readonly commandsRegistered: boolean;
}

/**
 * Typed port encapsulating the two capabilities a new guild needs:
 * connecting its database and registering its commands.
 *
 * Implementations must be safe to call exactly once per `guildCreate`
 * event. They own their own error handling for the command-registration
 * leg (a Discord API hiccup there must not abort onboarding); a failed
 * database connection, however, is surfaced to the caller because the
 * guild cannot function without it.
 */
export interface GuildOnboardingPort {
  /**
   * Connect the new guild's per-guild database and register the bot's
   * slash commands for it.
   *
   * @param guildId - the Discord snowflake of the newly joined guild.
   * @returns a {@link GuildOnboardingResult} describing what succeeded.
   * @throws when the per-guild database connection cannot be
   *   established — the guild is unusable without it.
   */
  onboardGuild(guildId: string): Promise<GuildOnboardingResult>;
}
