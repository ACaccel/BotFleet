import { escapeMarkdown, type InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { archivePanelButton, button, present, rows, type Job } from './presentation-common';
import { archiveManifestReply } from './manifest-presentation';
import { renderArchiveStatus } from './progress';
import { archiveGuildLabel, archiveSourceLabel } from './source-presentation';
import { archiveJobControls } from './job-controls';
import { manageBack, manageButton } from './manage-common';
import { markArchiveQueuedReply } from '../../../infra/archive/public-message';

const jobNavigation = (job: Job, bot: BaseBot) => {
  const t = bindTranslator(bot.translator);
  return [
    ...(job.status === 'queued'
      ? [archivePanelButton(job.jobId, t('replies:archive.panel_open'))].filter(present)
      : []),
    ...(job.status === 'running'
      ? [manageButton('job', job.jobId, t('replies:archive.manage_refresh'))]
      : []),
    ...(job.runId === undefined
      ? []
      : [manageButton('inspect', job.runId, t('replies:archive.view_summary'))]),
    manageBack('jobs', t),
  ];
};

const attachmentContext = (job: Job, bot: BaseBot, maxNameLength = 70): string[] => {
  if (job.command !== 'refresh-attachment') return [];
  const t = bindTranslator(bot.translator);
  const scope = job.attachment;
  if (scope === undefined) return [t('replies:archive.attachment_target_unknown')];
  const guild = bot.client?.guilds?.cache.get(job.guildId);
  return [
    t('replies:archive.attachment_target', {
      source: escapeMarkdown(
        archiveSourceLabel({ channelId: scope.channelId }, guild, t, maxNameLength),
      ),
      message:
        guild === undefined
          ? t('replies:archive.attachment_message', { messageId: scope.messageId })
          : `https://discord.com/channels/${job.guildId}/${scope.channelId}/${scope.messageId}`,
      attachmentId: scope.attachmentId,
    }),
  ];
};

export const archiveQueuedReply = (job: Job, bot: BaseBot): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  return markArchiveQueuedReply({
    content:
      t('replies:archive.job_queued', {
        command: t(`replies:archive.view_work_${job.command}`),
        state: t(`replies:archive.state_${job.status}`),
        server: escapeMarkdown(
          archiveGuildLabel(bot.client?.guilds?.cache.get(job.guildId), job.guildId),
        ),
        jobId: job.jobId,
      }) +
      (job.command === 'plan' ? `\n${t('replies:archive.plan_preparing')}` : '') +
      attachmentContext(job, bot)
        .map((line) => `\n${line}`)
        .join(''),
    components: rows([...archiveJobControls(job, t), ...jobNavigation(job, bot)]),
  });
};

export const archiveJobReply = async (
  job: Job,
  bot: BaseBot,
  control: ArchiveControlService,
  page: number | null,
  actor?: { userId: string; channelId: string; messageId?: string },
  footerLines: readonly string[] = [],
  loadedDetails?: Awaited<ReturnType<ArchiveControlService['progressDetails']>>,
): Promise<InteractionReplyOptions> => {
  const progress = {
    ...job.progress,
    jobId: job.jobId,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
  };
  if (
    actor !== undefined &&
    page === null &&
    job.runId !== undefined &&
    ['complete', 'partial', 'failed', 'cancelled'].includes(job.status)
  ) {
    return archiveManifestReply(job.runId, bot, control, actor, { view: 'summary' }, [
      ...archiveJobControls(job, bindTranslator(bot.translator)),
      ...(job.progress.gapCount > 0
        ? [
            button(
              `archive_panel|${job.jobId}|p|1`,
              bindTranslator(bot.translator)('replies:archive.public_issues'),
            ),
          ].filter(present)
        : []),
    ]);
  }
  const t = bindTranslator(bot.translator);
  const buttons = [];
  if (page === null && (job.progress.activityCount > 0 || job.progress.gapCount > 0))
    buttons.push(button(`archive_panel|${job.jobId}|p|1`, t('replies:archive.public_issues')));
  return {
    content: await renderArchiveStatus(progress, bot, control, job.jobId, page, footerLines, {
      guildId: job.guildId,
      contextLines: attachmentContext(job, bot, page === null ? 70 : 12),
      loadedDetails,
    }),
    components: rows([
      ...buttons.filter(present),
      ...archiveJobControls(job, t),
      ...jobNavigation(job, bot),
    ]),
  };
};
