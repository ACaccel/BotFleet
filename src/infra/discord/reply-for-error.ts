/**
 * Handler-boundary error reply helper.
 *
 * Every handler's `catch` block routes a failure down two independent
 * channels:
 *
 *   1. **Operator channel** — a structured log line carrying the full
 *      error (stack, `cause`, `context.operation`) plus the `traceId`.
 *      This always fires, regardless of the error's type.
 *   2. **User channel** — a single localised `editReply` / `reply`:
 *      - the error is a {@link DomainError} → use its taxonomy-driven
 *        `messageKey` + `messageParams`; the bot-personality tone for
 *        these lives in the `errors.json` catalog copy.
 *      - the error is **not** a `DomainError` (an unexpected bug, an
 *        unwrapped infra failure) → fall back to the command's own
 *        toned `replies:<feature>.failed` copy, interpolating a
 *        `traceId` so an operator can correlate the user's screenshot
 *        with the structured log line.
 *
 * Folding both channels into one boundary helper is deliberate: it is
 * the only way to *guarantee* the `traceId` shown to the user is the
 * same one written to the operator log. A two-call shape
 * (`logError(...)` then a separate reply) would let the two ids drift.
 *
 * The helper swallows expired-interaction Discord errors — see
 * `isExpiredInteractionError` — the same way {@link requireGuildRepos}'s
 * `replyOrEdit` does: a dead interaction cannot be replied to, and
 * re-throwing would only walk into the dispatcher's outer catch.
 */
import type { ContextMenuCommandInteraction, RepliableInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';

import { DomainError } from '../../core/errors';
import type { Translator } from '../../core/i18n';
import { logError, logSystem, ops, type Logger } from '../../core/logger';

import { isExpiredInteractionError } from './expired-interaction';

/**
 * Same widening rationale as `reply-translated.ts`: `executeCommand`
 * is typed against the abstract `ContextMenuCommandInteraction` base,
 * which is wider than the concrete subclasses `RepliableInteraction`
 * lists. Every value at runtime carries `.reply` / `.editReply`.
 */
type HandlerInteraction = RepliableInteraction | ContextMenuCommandInteraction;

/**
 * Short, stable correlation id minted for the non-`DomainError`
 * fallback path. Six lowercase base-36 chars is enough entropy for a
 * support-ticket lookup and stays readable inside a user-facing
 * message. Matches the shape `ConnectionManager` mints for disabled
 * guilds so operators see one consistent id format.
 */
const generateTraceId = (): string => Math.random().toString(36).slice(2, 8).padStart(6, '0');

/** How the user-facing error reply is delivered. */
export interface ErrorReplyOptions {
  /**
   * The interaction was acknowledged publicly but the error must reach only
   * the invoker: the public reply is deleted and the error sent as an
   * ephemeral follow-up instead of edited into it.
   */
  readonly privateAfterPublicReply?: boolean;
}

/** Reply or edit depending on the interaction's acknowledged state. */
const sendUserChannel = async (
  bot: { logger: Logger | undefined },
  interaction: HandlerInteraction,
  content: string,
  options: ErrorReplyOptions,
): Promise<void> => {
  if (content.length === 0) return;
  try {
    if ((interaction.deferred || interaction.replied) && options.privateAfterPublicReply === true) {
      await interaction.deleteReply();
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (err) {
    if (isExpiredInteractionError(err)) {
      logSystem(bot.logger, ops.router.replySkipped(err.code));
      return;
    }
    throw err;
  }
};

/**
 * Resolve the user-facing message for `error`.
 *
 * Exported for unit tests that want to assert the channel selection
 * without driving a Discord interaction fixture.
 *
 * A `DomainError` resolves taxonomy-driven via its `messageKey`. As a
 * defensive measure the helper detects an unresolved key — i18next
 * echoes the key verbatim on a catalog miss — and degrades to the
 * per-feature `replies:<feature>.failed` copy instead of surfacing a
 * raw `errors:*` key to the user. This keeps the boundary robust if a
 * `DomainError` ever carries a `messageKey` with no catalog entry.
 *
 * @param translator bot translator; `undefined` only in the pre-`run()`
 *   window, in which case the resolved string is empty.
 * @param error the caught value (a `DomainError`, a native `Error`, or
 *   any thrown value).
 * @param fallbackKey the command's `replies:<feature>.failed` key.
 * @param traceId correlation id, interpolated into the fallback copy.
 */
export const resolveErrorReply = (
  translator: Translator | undefined,
  error: unknown,
  fallbackKey: string,
  traceId: string,
): string => {
  if (translator === undefined) return '';
  if (error instanceof DomainError) {
    const resolved = translator.t(error.messageKey, error.messageParams);
    // i18next returns the key unchanged on a catalog miss. Fall back to
    // the toned per-feature copy rather than show a raw key.
    if (resolved !== error.messageKey && resolved.length > 0) {
      return resolved;
    }
    return translator.t(fallbackKey, { traceId });
  }
  return translator.t(fallbackKey, { traceId });
};

/** Context the boundary helper needs from the `BaseBot` instance. */
interface ErrorReplyBot {
  readonly logger: Logger | undefined;
  readonly translator: Translator | undefined;
}

/**
 * Handle a handler-boundary error: write the operator log and send the
 * user-facing reply, both stamped with the same `traceId`.
 *
 * @param interaction the interaction whose handler threw.
 * @param bot the running bot (logger / translator).
 * @param error the caught value.
 * @param fallbackKey the command's `replies:<feature>.failed` key, used
 *   only when `error` is not a `DomainError`.
 * @param guildId optional guild id for the structured log scope.
 * @param options delivery of the user-facing reply; see {@link ErrorReplyOptions}.
 */
export const replyForError = async (
  interaction: HandlerInteraction,
  bot: ErrorReplyBot,
  error: unknown,
  fallbackKey: string,
  guildId?: string | null,
  options: ErrorReplyOptions = {},
): Promise<void> => {
  const traceId = generateTraceId();
  // Operator channel: always log the full error. The `traceId` is
  // attached so the line correlates with the user-facing fallback
  // message; for a `DomainError` the id is unused by the user channel
  // but still recorded for completeness.
  logError(bot.logger, guildId ?? null, error);
  logSystem(bot.logger, ops.router.handlerError(traceId));
  // User channel.
  const content = resolveErrorReply(bot.translator, error, fallbackKey, traceId);
  await sendUserChannel(bot, interaction, content, options);
};
