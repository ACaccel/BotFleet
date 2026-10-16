import type { Guild, MessageReaction } from 'discord.js';

/** Count current human members holding any required role, without trusting cached totals. */
export const countEligibleVotes = async (
  reaction: Pick<MessageReaction, 'users'>,
  guild: Pick<Guild, 'members'>,
  voterRoleIds: readonly string[],
  threshold: number,
): Promise<number> => {
  let count = 0;
  let after: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
    for (const user of users.values()) {
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      if (user.bot) continue;
      try {
        const member = await guild.members.fetch({ user: user.id, force: true });
        if (voterRoleIds.length === 0 || voterRoleIds.some((id) => member.roles.cache.has(id))) {
          count++;
          if (count >= threshold) return count;
        }
      } catch (error: unknown) {
        // Departed members are ineligible; permission/network errors must stop judgement.
        if (
          !(error !== null && typeof error === 'object' && 'code' in error && error.code === 10007)
        )
          throw error;
      }
    }
    if (users.size < 100) return count;
    const cursor = users.last()?.id;
    if (!cursor || cursor === after) throw new Error('Vote pagination did not advance');
    after = cursor;
  }
};
