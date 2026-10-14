/**
 * Error replies for `/db`. Expected rejections (an unknown target, an invalid
 * filter, an expired panel) and classified database errors answer with their
 * own message; anything else is logged with the trace ID shown.
 */
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { BaseBot } from '@bot';

import { DbInspectError, DomainError } from '../../../core/errors';
import { bindTranslator } from '../../../core/i18n';
import { logError } from '../../../core/logger';
import { isExpiredInteractionError } from '../../../infra/discord/expired-interaction';

type DbInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

/**
 * Replies privately. A panel component never edits the panel it sits on;
 * a command or a detail view replaces its own deferred reply.
 */
export const dbFailure = async (
  interaction: DbInteraction,
  bot: BaseBot,
  error: unknown,
  options: { readonly keepMessage?: boolean } = {},
): Promise<void> => {
  const traceId = randomUUID().slice(0, 8);
  if (!(error instanceof DbInspectError)) logError(bot.logger, interaction.guildId, error);
  const t = bindTranslator(bot.translator);
  const translated =
    error instanceof DomainError ? t(error.messageKey, error.messageParams) : undefined;
  const content =
    translated !== undefined && error instanceof DomainError && translated !== error.messageKey
      ? translated
      : t('replies:db_inspect.failed', { traceId });
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else if (options.keepMessage === true) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.editReply({ content, embeds: [], components: [], files: [] });
    }
  } catch (replyError) {
    if (!isExpiredInteractionError(replyError)) throw replyError;
  }
};
