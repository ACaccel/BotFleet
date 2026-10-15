import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { unwrap } from '@core/result';
import { logError } from '@core/logger';
import { ancestorChannelIdsOf } from '../../../infra/discord';
import type { ThreadClaim } from '../../../persistence/repositories/thread-moderation.repo';
import { ButtonHandler } from '../button-handler';
import { buildThreadClaimCard } from '../../thread-claim-view';
import {
  assertThreadApplicant,
  requireThreadRepo,
  resolveManagedThread,
  ThreadManagementError,
  threadManagementFailure,
} from '../../thread-management-common';

export default class thread_claim extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!bot.isAdmin(interaction.user.id)) throw new ThreadManagementError('manager_admin_only');
      const match =
        /^thread_claim\|(approve|reject)\|(\d{17,20})\|(\d{17,20})\|([a-f0-9]{24})$/.exec(
          interaction.customId,
        );
      const [, action, guildId, threadId, claimId] = match ?? [];
      if (
        !guildId ||
        !threadId ||
        !claimId ||
        interaction.guildId !== null ||
        interaction.message.author.id !== bot.clientId
      ) {
        throw new ThreadManagementError('claim_stale');
      }
      const repo = requireThreadRepo(bot, guildId);
      const claim = unwrap(await repo.findClaim(bot.clientId, threadId, claimId));
      if (
        !claim ||
        !claim.notices.some(
          (notice) =>
            notice.admin_id === interaction.user.id &&
            notice.channel_id === interaction.channelId &&
            notice.message_id === interaction.message.id,
        )
      ) {
        throw new ThreadManagementError('claim_stale');
      }
      if (claim.status !== 'pending') throw new ThreadManagementError('claim_already_reviewed');
      if (claim.expires_at <= Date.now()) throw new ThreadManagementError('claim_expired');
      if (!claim.delivery_completed_at) throw new ThreadManagementError('claim_delivering');
      const approved = action === 'approve';
      if (approved) {
        const guild = await bot.client.guilds.fetch(guildId);
        const thread = await resolveManagedThread(guild, threadId);
        if (
          bot.guildSettings &&
          !bot.guildSettings.isEnabled(
            guildId,
            'thread_management',
            thread.id,
            thread.parentId
              ? [
                  thread.parentId,
                  ...ancestorChannelIdsOf(
                    guild.channels.cache.get(thread.parentId),
                    guild.channels.cache,
                  ),
                ]
              : [],
          )
        ) {
          await interaction.editReply({
            content:
              bot.translator?.t('replies:settings.feature_disabled', {
                feature: bot.translator?.t('replies:settings.feature.thread_management') ?? '',
              }) ?? '',
          });
          return;
        }
        if (thread.ownerId !== claim.owner_id)
          throw new ThreadManagementError('claim_owner_changed');
        await assertThreadApplicant(thread, claim.applicant_id);
      }
      const reviewedAt = Date.now();
      const decided = unwrap(
        await repo.decideClaim(
          bot.clientId,
          threadId,
          claimId,
          interaction.user.id,
          interaction.channelId,
          interaction.message.id,
          approved,
          reviewedAt,
        ),
      );
      if (!decided) throw new ThreadManagementError('claim_already_reviewed');
      // The successful CAS is authoritative; notification work must not turn a
      // committed decision into a reported failure if a later database read fails.
      const updated: ThreadClaim = {
        ...claim,
        status: approved ? 'approved' : 'rejected',
        reviewed_by: interaction.user.id,
        reviewed_at: reviewedAt,
      };
      {
        const changes = await Promise.allSettled(
          updated.notices.map(async (notice) => {
            const admin = await bot.client.users.fetch(notice.admin_id);
            const channel = await admin.createDM();
            if (channel.id !== notice.channel_id)
              throw new Error('Thread claim DM binding changed');
            const message = await channel.messages.fetch(notice.message_id);
            await message.edit(buildThreadClaimCard(bot, guildId, threadId, updated, false));
          }),
        );
        for (const result of changes)
          if (result.status === 'rejected') logError(bot.logger, guildId, result.reason);
      }
      await interaction.editReply({
        content:
          bot.translator?.t(
            `replies:thread_moderation.claim_${approved ? 'approved' : 'rejected'}`,
          ) ?? '',
        allowedMentions: { parse: [] },
      });
      try {
        const applicant = await bot.client.users.fetch(claim.applicant_id);
        await applicant.send({
          content: `${bot.translator?.t(`replies:thread_moderation.claim_${approved ? 'approved' : 'rejected'}`) ?? ''}\nhttps://discord.com/channels/${guildId}/${threadId}`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        logError(bot.logger, guildId, error);
      }
    } catch (error) {
      await threadManagementFailure(interaction, bot, error);
    }
  }
}
