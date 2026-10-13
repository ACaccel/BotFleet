import type { MessageCreateOptions } from 'discord.js';

import type { Translator } from '../../../core/i18n';

interface VoteMessageInput {
  readonly initiator: string;
  readonly target: string;
  readonly duration: number;
  readonly judgeTime: number;
  readonly threshold: number;
  /** The guild's configured voter role; omitted means nobody is pinged. */
  readonly voterRoleId?: string;
}

/**
 * Build the public vote call. Only the configured voter role may ping:
 * member display names are free text and must never resolve to a mention.
 */
export const buildVoteMessage = (
  translator: Translator | undefined,
  { voterRoleId, ...params }: VoteMessageInput,
): Pick<MessageCreateOptions, 'content' | 'allowedMentions'> => {
  const call = translator?.t('replies:ban_user.vote_call', params) ?? '';
  if (!voterRoleId) return { content: call, allowedMentions: { parse: [] } };
  const ping = translator?.t('replies:ban_user.vote_ping', { role: voterRoleId }) ?? '';
  return { content: `${call}\n${ping}`, allowedMentions: { roles: [voterRoleId] } };
};
