import { ARCHIVE_LIST_PAGE_SIZE } from './jobs-presentation';
import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  InteractionReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveAccess } from './access';
import { archivePublicReply, archivePublicReference } from './public-reply';
import { archiveConfirmationReply, archiveQueuedReply } from './presentation';
import { archiveManagePlan } from './manage-presentation';
import { archiveJobsReply } from './jobs-presentation';

export const archiveManageAdvanced = async (
  action: string,
  id: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<InteractionReplyOptions> => {
  if (action === 'advanced')
    return archiveJobsReply(
      await access.control.jobs({ all: true, limit: ARCHIVE_LIST_PAGE_SIZE }),
      bot,
      true,
    );
  if (action === 'plan-advanced')
    return archiveManagePlan(id, bot, access, {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
  if (action === 'apply' || action === 'resume' || action === 'rollback' || action === 'accept') {
    const actor = { userId: interaction.user.id, channelId: interaction.channelId };
    return archivePublicReply(
      archiveConfirmationReply(
        await access.control.requestConfirmation(action, id, actor),
        bot,
        actor,
      ),
      { runId: id },
    );
  }
  const command = action === 'audit' ? 'audit' : 'verify';
  const reference =
    command === 'verify' ? await archivePublicReference(access, { runId: id }) : undefined;
  const job = await access.control.submit(command, {
    ...(command === 'verify' ? { runId: id } : {}),
    notification: {
      channelId: access.debugId,
      ...(reference === undefined ? {} : { messageId: reference.messageId }),
    },
  });
  return archivePublicReply(archiveQueuedReply(job, bot), { jobId: job.jobId });
};
