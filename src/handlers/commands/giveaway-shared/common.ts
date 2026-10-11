import type { BaseBot } from '@bot';
import { asGuildId } from '../../../core/ids';
import type { BoundTranslate } from '../../../core/i18n';

/** The database reply: disabled guilds carry the trace ID of the startup failure. */
export const databaseUnavailableMessage = (
  bot: BaseBot,
  guildId: string,
  t: BoundTranslate,
): string => {
  const disabled = bot.connectionManager?.isDisabled(asGuildId(guildId));
  return disabled === undefined
    ? t('errors:db.not_found')
    : t('errors:db.guild_disabled', { traceId: disabled.traceId });
};
