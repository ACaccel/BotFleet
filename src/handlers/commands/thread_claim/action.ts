import { randomBytes } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import type { BaseBot } from '@bot';
import { unwrap } from '@core/result';
import { logError } from '@core/logger';
import { Command } from '../command';
import type { ThreadClaim } from '../../../persistence/repositories/thread-moderation.repo';
import { canManageThread } from '../../thread-moderation-access';
import { buildThreadClaimCard } from '../../thread-claim-view';
import {
  assertThreadApplicant,
  requireThreadRepo,
  resolveManagedThread,
  targetThreadId,
  ThreadManagementError,
  threadManagementFailure,
} from '../../thread-management-common';

export default class thread_claim extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'thread_claim',
      category: 'community',
      guildOnly: true,
      options: {
        channel: [{ name: 'thread', required: false }],
        string: [{ name: 'reason', required: true, minLength: 1, maxLength: 1000 }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!interaction.guild) throw new ThreadManagementError('thread_only');
      const repo = requireThreadRepo(bot, interaction.guild.id);
      const thread = await resolveManagedThread(interaction.guild, targetThreadId(interaction));
      await assertThreadApplicant(thread, interaction.user.id);
      if (!thread.ownerId) throw new ThreadManagementError('claim_owner_missing');
      if (await canManageThread(bot, interaction.guild.id, thread, interaction.user.id)) {
        throw new ThreadManagementError('manager_already');
      }
      const reason = interaction.options.getString('reason', true).trim();
      if (!reason || reason.length > 1000) throw new ThreadManagementError('claim_reason_invalid');
      const admins = [...new Set(bot.adminIds)];
      if (!admins.length) throw new ThreadManagementError('claim_no_admins');
      const now = Date.now();
      const claim: ThreadClaim = {
        id: randomBytes(12).toString('hex'),
        applicant_id: interaction.user.id,
        owner_id: thread.ownerId,
        reason,
        requested_at: now,
        expires_at: now + 7 * 86400_000,
        status: 'pending',
        notices: [],
      };
      const created = unwrap(await repo.createClaim(bot.clientId, thread.id, claim));
      if (created !== 'created') throw new ThreadManagementError(`claim_${created}`);
      const messages: { adminId: string; message: Message }[] = [];
      try {
        const deliveries = await Promise.allSettled(
          admins.map(async (adminId) => {
            const admin = await bot.client.users.fetch(adminId);
            const message = await admin.send(
              buildThreadClaimCard(bot, thread.guildId, thread.id, claim, false),
            );
            return { adminId, message };
          }),
        );
        for (const delivery of deliveries) {
          if (delivery.status === 'fulfilled') messages.push(delivery.value);
          else logError(bot.logger, thread.guildId, delivery.reason);
        }
        if (!messages.length) throw new ThreadManagementError('claim_delivery_failed');
        const notices = messages.map(({ adminId, message }) => ({
          admin_id: adminId,
          channel_id: message.channelId,
          message_id: message.id,
        }));
        if (!unwrap(await repo.bindClaimNotices(bot.clientId, thread.id, claim.id, notices))) {
          throw new ThreadManagementError('claim_delivery_failed');
        }
        const enabled = await Promise.allSettled(
          messages.map(({ message }) =>
            message.edit(
              buildThreadClaimCard(bot, thread.guildId, thread.id, { ...claim, notices }, true),
            ),
          ),
        );
        for (const result of enabled)
          if (result.status === 'rejected') logError(bot.logger, thread.guildId, result.reason);
        if (!enabled.some((result) => result.status === 'fulfilled'))
          throw new ThreadManagementError('claim_delivery_failed');
        if (
          !unwrap(await repo.completeClaimDelivery(bot.clientId, thread.id, claim.id, Date.now()))
        ) {
          throw new ThreadManagementError('claim_delivery_failed');
        }
      } catch (error) {
        try {
          unwrap(await repo.failClaimDelivery(bot.clientId, thread.id, claim.id));
        } catch (failure) {
          logError(bot.logger, thread.guildId, failure);
        }
        // Disabled initial cards cannot authorize an unbound or failed delivery.
        await Promise.allSettled(messages.map(({ message }) => message.edit({ components: [] })));
        throw error;
      }
      await interaction.editReply({
        content: bot.translator?.t('replies:thread_moderation.claim_submitted') ?? '',
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await threadManagementFailure(interaction, bot, error);
    }
  }
}
