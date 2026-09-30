/**
 * Fallback punishment for `/ban_user` when Discord refuses the timeout:
 * delete the target's messages for the same duration.
 *
 * Lifecycle: the listener is attached directly to the shared client
 * (not through the plugin dispatcher, which has no per-invocation
 * scope) and is removed by the timer below after exactly `durationMs`.
 * `off` uses the same function reference, and the timer is unref'd so a
 * pending removal cannot hold the process open during shutdown.
 */
import type { Client, Message } from 'discord.js';
import { Events } from 'discord.js';

import { logError, type Logger } from '@core/logger';
import { suppressAutoReplies } from '../../../infra/discord/suppressed-auto-replies';

interface MessageDeletionFallbackInput {
  readonly client: Client;
  readonly logger: Logger | undefined;
  /** Discord user id whose messages are deleted while the window is open. */
  readonly targetMemberId: string;
  /** Guild the punishment is scoped to; messages elsewhere are untouched. */
  readonly guildId: string | undefined;
  /** How long the deletion window stays open. */
  readonly durationMs: number;
}

/** Open the deletion window. Returns once the listener is attached. */
export const startMessageDeletionFallback = (input: MessageDeletionFallbackInput): void => {
  const expiresAt = Date.now() + input.durationMs;
  const deleteListener = async (msg: Message): Promise<void> => {
    if (
      Date.now() < expiresAt &&
      !msg.author.bot &&
      msg.author?.id === input.targetMemberId &&
      msg.guild?.id === input.guildId
    ) {
      suppressAutoReplies(msg);
      try {
        await msg.delete();
      } catch (err) {
        logError(input.logger, input.guildId, err);
      }
    }
  };
  // Mark before existing plugin listeners, without waiting for Discord deletion.
  input.client.prependListener(Events.MessageCreate, deleteListener);

  const removal = setTimeout(() => {
    input.client.off(Events.MessageCreate, deleteListener);
  }, input.durationMs);
  removal.unref?.();
};
