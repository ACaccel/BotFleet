import type { ButtonBuilder } from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import type { Job } from './presentation-common';
import { manageButton } from './manage-common';

export const archiveJobControls = (job: Job, t: BoundTranslate): ButtonBuilder[] => {
  if (job.deleteRequestedAt !== undefined) return [];
  const active = ['queued', 'running'].includes(job.status);
  if (active)
    return job.cancelRequested
      ? []
      : [manageButton('stop', job.jobId, t('replies:archive.public_cancel'))];
  return [manageButton('delete-job', job.jobId, t('replies:archive.manage_delete_job'), true)];
};
