/**
 * Operator-facing log message templates.
 *
 * Centralising them keeps lines greppable by their `ops:<area>.<event>`
 * prefix, gives each event a stable code, and stops the same idea drifting
 * when logged from several places. New operator-facing lines belong here;
 * throwaway debug lines may stay inline, and errors forwarded via
 * `logger.errorLogger(..., err)` take the `Error` value, not a message.
 *
 * Each event is a function returning the rendered line, so callers pass
 * values without touching the template.
 */

export const ops = {
  bot: {
    online: (name: string): string => `ops:bot.online | ${name} is online.`,
  },
  command: {
    registerStart: (): string => `ops:command.register_start | Registering commands...`,
    registerEmpty: (): string => `ops:command.register_empty | No commands to register.`,
    registerSuccess: (count: number): string =>
      `ops:command.register_success | Successfully registered ${count} application (/) commands.`,
    registerFailed: (commandName: string): string =>
      `ops:command.register_failed | Failed to register command ${commandName}`,
    guildSyncFailed: (guildId: string): string =>
      `ops:command.guild_sync_failed | Failed to sync commands for guild ${guildId}`,
    handlerMissingConfig: (commandName: string): string =>
      `ops:command.handler_missing_config | Command ${commandName} has no config.`,
    /**
     * Autocomplete could not be answered — the hook threw, or Discord
     * refused the response for a reason other than the window closing.
     * The member sees an empty suggestion list and nothing else, since
     * an autocomplete interaction cannot carry an error, so this line
     * is the only sign the feature is broken. Logged at error level
     * with the original failure attached as `cause`.
     */
    autocompleteFailed: (commandName: string): string =>
      `ops:command.autocomplete_failed | could not answer autocomplete for /${commandName}.`,
    /**
     * The three-second autocomplete window closed before the response
     * landed. Routine under load rather than a defect — the member who
     * kept typing has already moved on — so it stays an info line.
     */
    autocompleteExpired: (commandName: string, code: number | string): string =>
      `ops:command.autocomplete_expired | autocomplete for /${commandName} not delivered (code=${code}).`,
  },
  dbInspect: {
    /**
     * Audit line for one `/db` read. The structured fields name the member,
     * database, collection and filter; results are never logged.
     */
    read: (action: string): string => `ops:db_inspect.read | /db ${action}`,
  },
  feed: {
    /**
     * A destination channel the bot cannot post in. The permission
     * names are the raw discord.js flag identifiers — the operator has
     * to find them in Discord's own UI, which does not translate them.
     */
    missingBotPermissions: (channelId: string, permissions: string): string =>
      `ops:feed.missing_bot_permissions | cannot deliver to channel ${channelId}; missing ${permissions}.`,
    /**
     * Subscriptions removed by `/feed unsubscribe`, written before the
     * confirmation is sent. The reply is bounded and can be lost to a
     * delivery failure; this line is the durable record of what a
     * member actually deleted.
     */
    subscriptionsRemoved: (channelId: string, count: number, keys: string): string =>
      `ops:feed.subscriptions_removed | removed ${count} subscription(s) from channel ${channelId}: ${keys}`,
    /**
     * A whole-channel clear refused at the moment the member confirmed
     * it. They had already passed the same gate when the prompt was
     * built, so this line marks a change between the two — the one
     * denial in the flow that is worth an operator's attention.
     */
    clearDenied: (channelId: string, reason: string): string =>
      `ops:feed.clear_denied | refused to clear channel ${channelId}: ${reason}`,
    /**
     * The result of one `/feed subscribe` invocation, which may name
     * several accounts. Per-account failures are isolated so the batch
     * can finish, which means they never reach the handler's error
     * boundary — this line is where an operator sees them.
     */
    subscriptionsProcessed: (channelId: string, count: number, outcomes: string): string =>
      `ops:feed.subscriptions_processed | processed ${count} account(s) for channel ${channelId}: ${outcomes}`,
    /**
     * The subscription read behind `/feed unsubscribe`'s account
     * suggestions failed. Info rather than error because it fires once
     * per keystroke, but it must fire: the member just sees an empty
     * list, so without this line a degraded database is invisible on
     * this surface.
     */
    suggestionsUnavailable: (channelId: string, detail: string): string =>
      `ops:feed.suggestions_unavailable | could not read subscriptions of channel ${channelId} for suggestions: ${detail}`,
  },
  guildDb: {
    slotMissing: (guildId: string): string =>
      `ops:guild_db.slot_missing | connectOneGuild: no guildInfo slot for ${guildId}`,
    connectFailed: (guildId: string, traceId: string, detail: string): string =>
      `ops:guild_db.connect_failed | connectOneGuild failed for guild ${guildId} traceId=${traceId}: ${detail}`,
    connectSuccess: (guildId: string, guildName: string): string =>
      `ops:guild_db.connect_success | MongoDB for guild: ${guildId} - ${guildName} connected.`,
    poolStartFailed: (detail: string): string =>
      `ops:guild_db.pool_start_failed | Failed to connect to MongoDB: ${detail}`,
    uriMissing: (): string => `ops:guild_db.uri_missing | No MongoDB URI.`,
    poolStart: (): string => `ops:guild_db.pool_start | Connecting to MongoDB...`,
  },
  graphics: {
    /**
     * A remote picture (custom emoji, sticker, avatar) could not be drawn, so
     * the image shows a placeholder. Rate-limited per host; `suppressed` counts
     * the failures since the previous line.
     */
    imageDownloadFailed: (host: string, code: string, suppressed: number): string =>
      `ops:graphics.image_download_failed | ${host} (${code}); ${suppressed} more since the last report.`,
    /** The colour emoji font is missing or unusable; Unicode emoji are left out of images. */
    emojiFontUnavailable: (): string =>
      `ops:graphics.emoji_font_unavailable | colour emoji font unavailable; images omit Unicode emoji.`,
  },
  router: {
    replySkipped: (code: number | string): string =>
      `ops:router.reply_skipped | discord reply skipped (expired interaction, code=${code}).`,
    /**
     * Correlation marker for a handler-boundary error. The `traceId`
     * matches the id interpolated into the user-facing
     * `replies:<feature>.failed` copy so operators can `grep` from a
     * support ticket back to the structured error line.
     */
    handlerError: (traceId: string): string =>
      `ops:router.handler_error | handler boundary error (traceId=${traceId}).`,
    /**
     * One page of a paginated ephemeral reply could not be delivered.
     * The index is 0-based and matches the page order the user sees, so
     * an operator can tell "the header never landed" from "the tail was
     * truncated".
     */
    pageSendFailed: (index: number, total: number): string =>
      `ops:router.page_send_failed | paged reply page ${index + 1}/${total} could not be sent.`,
  },
} as const;
