import type { MessageCreateOptions } from 'discord.js';

import type { Translator } from '../../../core/i18n';

interface VoteMessageInput {
  readonly initiator: string;
  readonly target: string;
  readonly duration: number;
  readonly judgeTime: number;
  readonly judgeSeconds?: number;
  readonly threshold: number;
  /** The guild's configured voter role; omitted means nobody is pinged. */
  readonly voterRoleId?: string;
  /** Per-guild voter restrictions; empty means all members and no role ping. */
  readonly voterRoleIds?: readonly string[];
  /** The bot's closing line; empty adds nothing. */
  readonly flavor: string;
}

/**
 * Build the public vote call. Only the configured voter role may ping:
 * member display names are free text and must never resolve to a mention.
 */
export const buildVoteMessage = (
  translator: Translator | undefined,
  { voterRoleId, voterRoleIds, flavor, ...params }: VoteMessageInput,
): Pick<MessageCreateOptions, 'content' | 'allowedMentions'> => {
  const call =
    translator?.t(
      params.judgeSeconds === undefined
        ? 'replies:ban_user.vote_call'
        : 'replies:ban_user.vote_call_seconds',
      params,
    ) ?? '';
  if (voterRoleIds && voterRoleIds.length > 0) {
    const roles = [...new Set(voterRoleIds)];
    const ping =
      translator?.t('replies:ban_user.vote_ping_roles', {
        roles: roles.map((id) => `<@&${id}>`).join(' '),
        flavor,
      }) ?? '';
    return { content: `${call}\n${ping.trimEnd()}`, allowedMentions: { roles } };
  }
  if (!voterRoleId) {
    return { content: flavor ? `${call}\n${flavor}` : call, allowedMentions: { parse: [] } };
  }
  const ping = translator?.t('replies:ban_user.vote_ping', { role: voterRoleId, flavor }) ?? '';
  return { content: `${call}\n${ping.trimEnd()}`, allowedMentions: { roles: [voterRoleId] } };
};
