import type { BaseBot } from '@bot';

export const canManageThread = async (
  bot: BaseBot,
  guildId: string,
  thread: { id: string; ownerId: string | null },
  userId: string,
): Promise<boolean> => {
  if (bot.isAdmin(userId) || userId === thread.ownerId) return true;
  const repos = bot.getRepos(guildId);
  if (repos === undefined) throw new Error('Thread moderation repository unavailable');
  const result = await repos.threadModeration.isManager(bot.clientId, thread.id, userId);
  if (!result.ok) throw result.error;
  return result.value;
};
