import { MessageReferenceType, MessageType, type Message } from 'discord.js';
import type { ThreadModerationRepo } from '../persistence/repositories/thread-moderation.repo';

/** Follow only Discord-authenticated interaction and same-thread reply references. */
export const findThreadMessageSource = async (
  message: Message,
  botId: string,
  repo: Pick<ThreadModerationRepo, 'findMessageSource'> | undefined,
  remaining = 3,
): Promise<string | undefined> => {
  const actorId = message.interactionMetadata?.user.id ?? message.interaction?.user.id;
  if (actorId !== undefined) return actorId;
  const reference = message.reference;
  if (
    remaining === 0 ||
    message.type !== MessageType.Reply ||
    !reference?.messageId ||
    reference.type !== MessageReferenceType.Default ||
    reference.channelId !== message.channel.id ||
    (reference.guildId !== undefined && reference.guildId !== message.guildId)
  ) {
    return undefined;
  }
  if (repo === undefined) throw new Error('Thread moderation repository is unavailable');
  const stored = await repo.findMessageSource(botId, message.channel.id, reference.messageId);
  if (!stored.ok) throw stored.error;
  if (stored.value !== undefined) return stored.value;
  const original = await message.channel.messages.fetch(reference.messageId);
  if (original.channel.id !== message.channel.id || original.guildId !== message.guildId) {
    return undefined;
  }
  if (!original.author.bot) return original.author.id;
  return findThreadMessageSource(original, botId, repo, remaining - 1);
};
