import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveAccess } from './access';
import { archiveJobReply } from './job-presentation';
import { archiveManifestReply } from './manifest-presentation';
import { archivePublicReply } from './public-reply';

interface ArchiveManagementActor {
  userId: string;
  channelId: string;
  messageId?: string;
}

export const archiveManageJob = async (
  id: string,
  bot: BaseBot,
  access: ArchiveAccess,
  actor: ArchiveManagementActor,
): Promise<InteractionReplyOptions> => {
  const job = await access.control.status(id);
  const stopping = job.cancelRequested && ['queued', 'running'].includes(job.status);
  return archivePublicReply(
    await archiveJobReply(
      job,
      bot,
      access.control,
      null,
      actor,
      stopping ? [bindTranslator(bot.translator)('replies:archive.manage_stopping')] : [],
    ),
    { jobId: id },
  );
};

export const archiveManagePlan = async (
  id: string,
  bot: BaseBot,
  access: ArchiveAccess,
  actor: ArchiveManagementActor,
): Promise<InteractionReplyOptions> =>
  archivePublicReply(
    await archiveManifestReply(id, bot, access.control, actor, { view: 'summary' }),
    { runId: id },
  );
