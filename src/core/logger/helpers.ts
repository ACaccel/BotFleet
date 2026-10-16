/**
 * Handler-facing structured-log helpers — the canonical facade over the
 * typed {@link Logger} for handler / plugin / event callsites.
 *
 * Invariant: the {@link Logger} passed in MUST already carry `bot` in
 * its base bindings. `createBootstrapLogger` (the only production
 * Logger factory) attaches `{ bot: <clientId> }` via pino's `base`, so
 * every child inherits it. These helpers therefore never re-bind `bot`
 * themselves: a second binding would put two `bot` fields on every JSON
 * record, which pino's pretty printer and `jq` consumers would have to
 * disambiguate. No helper takes a `clientId` parameter, so there is no
 * way to reintroduce the duplicate.
 *
 * Depends only on the {@link Logger} interface; helpers that touch
 * discord.js / axios / fs live under `src/infra/discord/`.
 */
import type { Logger } from './logger';

/**
 * Log an unexpected error. `err` may be a DomainError instance, a native
 * Error, or any thrown value — pino's serialiser preserves stack + cause
 * for Error subclasses; non-Error throws are emitted under the `raw` key.
 *
 * `logger === undefined` is a defensive no-op for the pre-`run()` window;
 * any handler-context callsite is guaranteed to receive a defined logger.
 */
export const logError = (
  logger: Logger | undefined,
  guildId: string | null | undefined,
  err: unknown,
): void => {
  if (logger === undefined) return;
  const child =
    guildId === null || guildId === undefined || guildId === ''
      ? logger
      : logger.child({ guildId });
  if (err instanceof Error) {
    child.error({ err }, 'errorLogger');
  } else {
    child.error({ raw: err }, 'errorLogger');
  }
};

/**
 * Bot-scoped info-level log for operator-facing system messages.
 *
 * `msg` is passed as the pino headline argument (not in a binding
 * object). The prior shape — `info({ msg }, 'system')` — collided with
 * pino's `messageKey` default (`'msg'`), so the binding silently
 * overrode the literal headline and the pretty output lost the
 * operator-supplied text. Passing `msg` positionally avoids the
 * collision and keeps the headline visible in both pretty and JSON
 * sinks. `bot` is ambient via the logger's base bindings, so there is
 * no `child({ bot })` rebind here.
 */
export const logSystem = (logger: Logger | undefined, msg: string): void => {
  logger?.info(msg);
};

/**
 * Audit-log-style line tagged with the guild's display name.
 *
 * `details` carries the event-specific structured fields (command,
 * user, channel, oldMessage / newMessage, etc.). It is splatted onto
 * the pino record so file consumers (`jq`, log search) can filter on
 * the exact field; the headline is the upper-cased `eventType` so
 * pretty consoles read like `MESSAGE_UPDATE`. Newlines inside any
 * string field are preserved verbatim — JSON.stringify escapes them
 * in the file sink, and pretty rendering shows them on one line per
 * field via the multi-line formatter. `bot` is ambient via the
 * logger's base bindings; only `guildId` / `guildName` are bound here.
 */
export const logGuildEvent = (
  logger: Logger | undefined,
  guildId: string,
  eventType: string,
  details: Readonly<Record<string, unknown>>,
  guildName: string,
): void => {
  const headline = eventType.toUpperCase();
  logger?.child({ guildId, guildName }).info({ eventType: headline, ...details }, headline);
};
