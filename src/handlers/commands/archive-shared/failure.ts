import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BaseBot } from '@bot';
import {
  ArchiveAccessError,
  ArchiveControlError,
  ArchiveInputError,
  DomainError,
  type AnyDomainError,
} from '../../../core/errors';
import { bindTranslator } from '../../../core/i18n';
import { isExpiredInteractionError } from '../../../infra/discord/expired-interaction';

type ArchiveReply = { key: string; params?: Readonly<Record<string, string | number>> };
const isExpectedRejection = (error: unknown): error is AnyDomainError =>
  error instanceof ArchiveAccessError ||
  error instanceof ArchiveInputError ||
  error instanceof ArchiveControlError;
/** Expected rejections get their own reply; anything else is logged and generic. */
const expectedReply = (error: unknown): ArchiveReply | undefined =>
  isExpectedRejection(error)
    ? {
        key: error.messageKey,
        ...(error.messageParams === undefined ? {} : { params: error.messageParams }),
      }
    : error instanceof z.ZodError
      ? { key: 'replies:archive.invalid_input' }
      : undefined;

/**
 * Replies privately so a rejected button never changes the shared panel; a command
 * replaces its deferred reply. An unexpected error is logged with the trace ID the
 * operator sees.
 */
export const archiveFailure = async (
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  bot: BaseBot,
  error: unknown,
): Promise<void> => {
  const expected = expectedReply(error);
  const traceId = randomUUID().slice(0, 8);
  // Configuration faults and unexpected errors reach the log with the shown trace ID.
  if (expected === undefined)
    bot.logger?.error(
      { err: error, guildId: interaction.guildId, traceId },
      error instanceof DomainError ? 'Archive control misconfigured' : 'Archive control failed',
    );
  const content = bindTranslator(bot.translator)(
    expected?.key ?? 'replies:archive.failed',
    expected?.params ?? { traceId },
  );
  try {
    if (!interaction.deferred && !interaction.replied)
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    else if (interaction.isButton())
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.editReply({ content, embeds: [], components: [] });
  } catch (replyError) {
    if (!isExpiredInteractionError(replyError)) throw replyError;
    bot.logger?.warn({ guildId: interaction.guildId, traceId }, 'Archive failure reply expired');
  }
};
