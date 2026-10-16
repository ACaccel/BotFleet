import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { BaseBot } from '@bot';
import { logError } from '@core/logger';
import type { ThreadClaim } from '../persistence/repositories/thread-moderation.repo';
import { EMBED_COLORS } from '../infra/discord/presentation-colors';

const CLAIM_COLORS: Readonly<Record<ThreadClaim['status'] | 'expired', number>> = {
  pending: EMBED_COLORS.warning,
  approved: EMBED_COLORS.success,
  rejected: EMBED_COLORS.neutral,
  delivery_failed: EMBED_COLORS.error,
  expired: EMBED_COLORS.neutral,
};

interface ThreadClaimCard {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: never[] };
}

export const buildThreadClaimCard = (
  bot: BaseBot,
  guildId: string,
  threadId: string,
  claim: ThreadClaim,
  enabled: boolean,
): ThreadClaimCard => {
  const t = (key: string) => bot.translator?.t(`replies:thread_moderation.${key}`) ?? '';
  const expired = claim.expires_at <= Date.now();
  const pending = claim.status === 'pending' && !expired;
  const status = expired && claim.status === 'pending' ? 'expired' : claim.status;
  const embed = new EmbedBuilder()
    .setColor(CLAIM_COLORS[status])
    .setTitle(t('claim_title'))
    .setDescription(
      `https://discord.com/channels/${guildId}/${threadId}\n\n${t('claim_reason')}\n${escapeMarkdown(claim.reason)}`,
    )
    .addFields(
      { name: t('claim_applicant'), value: `<@${claim.applicant_id}> (\`${claim.applicant_id}\`)` },
      { name: t('claim_owner'), value: `<@${claim.owner_id}> (\`${claim.owner_id}\`)` },
      { name: t('claim_status'), value: t(`claim_status_${status}`) },
      { name: t('claim_expires'), value: `<t:${Math.floor(claim.expires_at / 1000)}:f>` },
    )
    .setTimestamp(claim.requested_at);
  if (claim.reviewed_by)
    embed.addFields({ name: t('claim_reviewer'), value: `<@${claim.reviewed_by}>` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`thread_claim|approve|${guildId}|${threadId}|${claim.id}`)
      .setLabel(t('claim_approve'))
      .setStyle(ButtonStyle.Success)
      .setDisabled(!enabled || !pending),
    new ButtonBuilder()
      .setCustomId(`thread_claim|reject|${guildId}|${threadId}|${claim.id}`)
      .setLabel(t('claim_reject'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!enabled || !pending),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
};

/** Best-effort: a committed decision stands even if the applicant cannot be reached. */
export const notifyClaimApplicant = async (
  bot: BaseBot,
  guildId: string,
  threadId: string,
  applicantId: string,
  approved: boolean,
  thread: ThreadChannel | undefined,
): Promise<void> => {
  const notice =
    bot.translator?.t(
      `replies:thread_moderation.claim_applicant_${approved ? 'approved' : 'rejected'}`,
    ) ?? '';
  try {
    const applicant = await bot.client.users.fetch(applicantId);
    await applicant.send({
      content: `${notice}\nhttps://discord.com/channels/${guildId}/${threadId}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logError(bot.logger, guildId, error);
    // Only approvals fall back to a public mention; rejections stay private.
    if (!approved || !thread) return;
    try {
      await thread.send({
        content: `<@${applicantId}> ${notice}`,
        allowedMentions: { users: [applicantId] },
      });
    } catch (fallbackError) {
      logError(bot.logger, guildId, fallbackError);
    }
  }
};
