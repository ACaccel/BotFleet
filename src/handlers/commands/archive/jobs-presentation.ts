import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { date, rows } from './presentation-common';
import { manageButton } from './manage-common';

/** Two entries leave room for refresh, reviewed deletion and forward navigation. */
export const ARCHIVE_LIST_PAGE_SIZE = 2;

export const archiveJobsReply = (
  result: Awaited<ReturnType<ArchiveControlService['jobs']>>,
  bot: BaseBot,
  all = false,
): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  const jobs = result.jobs.slice(0, ARCHIVE_LIST_PAGE_SIZE);
  const labels = jobs.map(
    (job, index) =>
      `${index + 1}. ${t(`replies:archive.view_work_${job.command}`)} · ${t(`replies:archive.state_${job.progress.state}`)}`,
  );
  const buttons = jobs.map((job, index) =>
    manageButton('job', job.jobId, labels[index]!.slice(0, 80)),
  );
  buttons.push(
    manageButton(all ? 'jobs' : 'jobs-active', 'first', t('replies:archive.manage_refresh')),
  );
  if (jobs.length > 0)
    buttons.push(
      manageButton('delete-all-jobs', 'guild', t('replies:archive.bulk_delete_jobs'), true),
    );
  // Legacy callers can supply longer pages; continue after the last displayed item.
  const nextCursor = result.jobs.length > jobs.length ? jobs.at(-1)?.jobId : result.nextCursor;
  if (nextCursor !== undefined)
    buttons.push(
      manageButton(all ? 'jobs' : 'jobs-active', nextCursor, t('replies:archive.page_next')),
    );
  return {
    content: [
      t('replies:archive.jobs_heading'),
      ...jobs.map((job, index) => `${labels[index]} — ${date(job.createdAt)}`),
      ...(jobs.length === 0 ? [t('replies:archive.no_jobs')] : []),
    ].join('\n'),
    components: rows(buttons),
  };
};
