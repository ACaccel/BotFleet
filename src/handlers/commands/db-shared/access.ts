/**
 * Access to `/db` and its panels: the bot's configured admins only, on the
 * personality that publishes the inspection service.
 */
import type { BaseBot } from '@bot';

import type { DbInspectService } from '../../../application/db-inspect/service';
import { DbInspectError } from '../../../core/errors';
import { getOptionalString, type OptionSource } from '../../../infra/discord/options';

/** The service when `userId` may inspect; `undefined` for a non-admin. */
export const dbInspectServiceFor = (bot: BaseBot, userId: string): DbInspectService | undefined =>
  bot.isAdmin(userId) ? bot.dbInspectService : undefined;

/** The admin's service, or a rejection naming why it is missing. */
export const requireDbInspectService = (bot: BaseBot): DbInspectService => {
  const service = bot.dbInspectService;
  if (service === undefined) throw new DbInspectError('DB_INSPECT_UNAVAILABLE');
  return service;
};

/** The `guild` option, else the guild the command runs in; `undefined` in a DM without one. */
export const chosenDatabase = (
  source: OptionSource & { readonly guildId: string | null },
): string | undefined => getOptionalString(source, 'guild') ?? source.guildId ?? undefined;

/** As {@link chosenDatabase}, rejecting a DM without a `guild` option. */
export const requireDatabase = (
  source: OptionSource & { readonly guildId: string | null },
): string => {
  const database = chosenDatabase(source);
  if (database === undefined) throw new DbInspectError('DB_INSPECT_GUILD_REQUIRED');
  return database;
};
