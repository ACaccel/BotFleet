import { ARCHIVE_LIST_PAGE_SIZE } from './jobs-presentation';
import type { ChatInputCommandInteraction, InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { ArchiveAccessError, type ArchiveAccess } from './access';
import { archivePublicReply, archivePublicReference } from './public-reply';
import { confirmedActions } from './config';
import { archiveStatusPage } from './progress';
import { archiveGuildLabel } from './source-presentation';
import { escapeMarkdown } from 'discord.js';
import { archivePlansReply } from './plans-presentation';
import {
  archiveCategories,
  archiveConfirmationReply,
  archiveJobReply,
  archiveJobsReply,
  archiveManifestReply,
  archiveQueuedReply,
} from './presentation';
import type { ArchiveView } from './presentation';

export const executeArchiveOperation = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  control: ArchiveControlService,
  access?: ArchiveAccess,
): Promise<InteractionReplyOptions | undefined> => {
  const t = bindTranslator(bot.translator);
  const action = interaction.options.getSubcommand();
  const runId = interaction.options.getString('run_id') ?? undefined;
  const jobId = interaction.options.getString('job_id') ?? undefined;
  const actor = { userId: interaction.user.id, channelId: interaction.channelId };
  if (action === 'plans')
    return archivePlansReply(await control.plans({ limit: ARCHIVE_LIST_PAGE_SIZE }), bot);
  if (confirmedActions.some((value) => value === action)) {
    if (runId === undefined) throw new ArchiveAccessError('replies:archive.invalid_action');
    const confirmedAction = confirmedActions.find((value) => value === action);
    if (confirmedAction === undefined)
      throw new ArchiveAccessError('replies:archive.invalid_action');
    const confirmation = await control.requestConfirmation(confirmedAction, runId, actor);
    return archivePublicReply(archiveConfirmationReply(confirmation, bot, actor), { runId });
  }
  if (action === 'purge-jobs') {
    if (interaction.options.getString('confirm', true) !== 'delete')
      throw new ArchiveAccessError('replies:archive.invalid_input');
    const result = await control.purgeJobs();
    return {
      content: t('replies:archive.jobs_purged', {
        ...result,
        server: escapeMarkdown(archiveGuildLabel(interaction.guild, interaction.guildId ?? '')),
      }),
    };
  }
  if (action === 'jobs')
    return archiveJobsReply(
      await control.jobs({ all: true, limit: ARCHIVE_LIST_PAGE_SIZE }),
      bot,
      true,
    );
  if (action === 'inspect' && runId !== undefined) {
    const afterSequence = interaction.options.getInteger('after_sequence');
    const limit = interaction.options.getInteger('limit');
    const selectedView = interaction.options.getString('view');
    const selectedCategory = interaction.options.getString('category');
    if (selectedView !== null && !['summary', 'changes', 'technical'].includes(selectedView))
      throw new ArchiveAccessError('replies:archive.invalid_input');
    const category = archiveCategories.find((value) => value === selectedCategory);
    if (selectedCategory !== null && category === undefined)
      throw new ArchiveAccessError('replies:archive.invalid_input');
    const view = (selectedView ??
      (afterSequence !== null || limit !== null || category !== undefined
        ? 'changes'
        : 'summary')) as ArchiveView;
    return archivePublicReply(
      await archiveManifestReply(runId, bot, control, actor, {
        view,
        ...(afterSequence === null ? {} : { afterSequence }),
        ...(category === undefined ? {} : { category }),
        limit: Math.min(limit ?? 5, 5),
      }),
      { runId },
    );
  }
  if ((action === 'status' || action === 'cancel') && jobId !== undefined) {
    const page = action === 'status' ? archiveStatusPage(interaction) : null;
    const job = action === 'status' ? await control.status(jobId) : await control.cancel(jobId);
    const reply = await archiveJobReply(
      job,
      bot,
      control,
      page,
      action === 'status' ? actor : undefined,
      action === 'cancel' && !['cancelled', 'cancelling'].includes(job.progress.state)
        ? [t('replies:archive.cancel_effect')]
        : [],
    );
    return archivePublicReply(reply, { jobId });
  }
  if (
    action === 'audit' ||
    action === 'plan' ||
    action === 'backup' ||
    action === 'verify' ||
    action === 'refresh-attachment'
  ) {
    if (action === 'verify' && runId === undefined)
      throw new ArchiveAccessError('replies:archive.invalid_action');
    const existing =
      runId === undefined || access === undefined
        ? undefined
        : await archivePublicReference(access, { runId });
    const notification = {
      channelId: interaction.channelId,
      ...(existing === undefined ? {} : { messageId: existing.messageId }),
    };
    const options =
      action === 'refresh-attachment'
        ? {
            channelId: interaction.options.getChannel('channel', true).id,
            messageId: interaction.options.getString('message_id', true) ?? undefined,
            attachmentId: interaction.options.getString('attachment_id', true) ?? undefined,
            userId: interaction.user.id,
            notification,
          }
        : { ...(runId !== undefined ? { runId } : {}), notification };
    const job = await control.submit(action === 'backup' ? 'plan' : action, options);
    return archivePublicReply(
      job.status === 'queued'
        ? archiveQueuedReply(job, bot)
        : await archiveJobReply(job, bot, control, null),
      { jobId: job.jobId },
    );
  }
  throw new ArchiveAccessError('replies:archive.invalid_action');
};
