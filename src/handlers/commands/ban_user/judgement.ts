import type { Guild, GuildMember, Message } from 'discord.js';
import type { BaseBot } from '@bot';

import { logError } from '@core/logger';
import type { TranslationParams } from '@core/i18n';
import { countEligibleVotes } from '../../../application/guild-settings/vote';
import { startMessageDeletionFallback } from './delete-messages-fallback';

interface VoteJudgementInput {
  readonly bot: BaseBot;
  readonly guild: Guild | null;
  readonly judgeMessage: Message;
  readonly member: GuildMember;
  /** Guild settings govern this poll: fresh eligibility checks and no deletion fallback. */
  readonly enforced: boolean;
  /** Voter roles captured at poll start; undefined counts raw reactions. */
  readonly voterRoleIds: readonly string[] | undefined;
  readonly threshold: number;
  readonly duration: number;
  /** Re-reads the saved policy; false cancels any pending punishment. */
  readonly voteEnabled: () => boolean;
}

/** Count the poll at its deadline and apply the timeout when it passes. */
export const judgeVote = async ({
  bot,
  guild,
  judgeMessage,
  member,
  enforced,
  voterRoleIds,
  threshold,
  duration,
  voteEnabled,
}: VoteJudgementInput): Promise<void> => {
  const reply = (key: string, params?: TranslationParams) =>
    judgeMessage.reply(bot.translator?.t(key, params) ?? '');
  if (!voteEnabled()) {
    await reply('replies:ban_user.vote_cancelled');
    return;
  }
  const emoji = judgeMessage.reactions.resolve('👍');
  if (!emoji) {
    await reply('replies:ban_user.cannot_get_votes');
    return;
  }
  const count =
    voterRoleIds && guild
      ? await countEligibleVotes(emoji, guild, voterRoleIds, threshold)
      : emoji.count - 1;
  if (!voteEnabled()) {
    await reply('replies:ban_user.vote_cancelled');
    return;
  }
  if (count < threshold) {
    await reply('replies:ban_user.vote_failed', { count, threshold });
    return;
  }
  const target =
    enforced && guild ? await guild.members.fetch({ user: member.id, force: true }) : member;
  if (enforced && !target.moderatable) {
    await reply('replies:ban_user.target_ineligible');
    return;
  }
  if (!voteEnabled()) {
    await reply('replies:ban_user.vote_cancelled');
    return;
  }
  try {
    await target.timeout(
      duration * 60 * 1000,
      bot.translator?.t('replies:ban_user.timeout_reason', { persona: bot.personaName }) ?? '',
    );
    await reply('replies:ban_user.timed_out', {
      persona: bot.personaName,
      user: member.user.tag,
      duration,
    });
  } catch (timeoutErr) {
    // Usually a missing ModerateMembers permission or a target above
    // the bot in the role hierarchy; the operator needs to see which.
    logError(bot.logger, guild?.id, timeoutErr);
    if (enforced) {
      await reply('replies:ban_user.timeout_refused');
      return;
    }
    await reply('replies:ban_user.cannot_timeout', { persona: bot.personaName });
    startMessageDeletionFallback({
      client: bot.client,
      logger: bot.logger,
      targetMemberId: member.id,
      guildId: guild?.id,
      durationMs: duration * 60 * 1000,
    });
  }
};
