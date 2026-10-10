import { ARCHIVE_LIST_PAGE_SIZE } from './jobs-presentation';
import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  InteractionReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveAccess } from './access';
import { ArchiveAccessError } from './access';
import { archiveJobsReply, archiveJobReply, archiveManifestReply } from './presentation';
import { archivePlansReply } from './plans-presentation';
import { archiveManageJob, archiveManagePlan } from './manage-presentation';
import { archiveManageDeletion } from './manage-deletion';
import { archiveManageAdvanced } from './manage-advanced';
import { archivePublicReply, ensureArchivePublicReference } from './public-reply';
import { archiveManageBulkDeletion } from './manage-bulk-deletion';

export const dispatchArchiveManagement = async (
  action: string,
  id: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<InteractionReplyOptions> => {
  const before = id === 'first' ? undefined : id;
  const actor = {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    messageId: interaction.message.id,
  };
  if (['delete-all-jobs', 'delete-all-plans', 'bulk-confirm', 'bulk-result'].includes(action))
    return archiveManageBulkDeletion(action, id, interaction, bot, access);
  if (action === 'jobs' || action === 'jobs-active')
    return archiveJobsReply(
      await access.control.jobs({ all: action === 'jobs', before, limit: ARCHIVE_LIST_PAGE_SIZE }),
      bot,
      action === 'jobs',
    );
  if (action === 'plans')
    return archivePlansReply(
      await access.control.plans({ before, limit: ARCHIVE_LIST_PAGE_SIZE }),
      bot,
    );
  if (action === 'job') return archiveManageJob(id, bot, access, actor);
  if (action === 'plan') return archiveManagePlan(id, bot, access, actor);
  if (action === 'pause-plan') {
    let target: unknown;
    try {
      target = JSON.parse(id);
    } catch {
      throw new ArchiveAccessError('replies:archive.navigation_stale');
    }
    if (
      typeof target !== 'object' ||
      target === null ||
      !('runId' in target) ||
      typeof target.runId !== 'string' ||
      !('jobId' in target) ||
      typeof target.jobId !== 'string'
    )
      throw new ArchiveAccessError('replies:archive.navigation_stale');
    await access.control.pauseRun(target.runId, target.jobId);
    await ensureArchivePublicReference(bot, access, { runId: target.runId });
    return archiveManagePlan(target.runId, bot, access, actor);
  }
  if (action === 'stop') {
    await access.control.stop(id);
    await ensureArchivePublicReference(bot, access, { jobId: id });
    return archiveManageJob(id, bot, access, actor);
  }
  if (['delete-job', 'delete-plan', 'delete-confirm'].includes(action))
    return archiveManageDeletion(action, id, interaction, bot, access);
  if (action === 'inspect' || action === 'changes' || action === 'technical')
    return archivePublicReply(
      await archiveManifestReply(id, bot, access.control, actor, {
        view: action === 'inspect' ? 'summary' : action,
      }),
      { runId: id },
    );
  if (action === 'details')
    return archivePublicReply(
      await archiveJobReply(await access.control.status(id), bot, access.control, null, actor),
      { jobId: id },
    );
  if (
    [
      'advanced',
      'plan-advanced',
      'apply',
      'resume',
      'rollback',
      'accept',
      'audit',
      'verify',
    ].includes(action)
  )
    return archiveManageAdvanced(action, id, interaction, bot, access);
  throw new ArchiveAccessError('replies:archive.invalid_action');
};
