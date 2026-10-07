import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveBulkDeletionService } from '../../../infra/archive/bulk-deletion';
import { date, rows } from './presentation-common';
import { manageBack, manageButton } from './manage-common';
import { archiveBulkPublicReply } from './bulk-public-reply';

type Review = Awaited<ReturnType<ArchiveBulkDeletionService['review']>>;
type Progress = Awaited<ReturnType<ArchiveBulkDeletionService['execute']>>;

export const archiveBulkReviewReply = (review: Review, bot: BaseBot): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  return archiveBulkPublicReply({
    content: [
      t(`replies:archive.bulk_review_${review.kind}`),
      t('replies:archive.bulk_scope'),
      t('replies:archive.bulk_review_counts', {
        total: review.total,
        eligible: review.eligible,
        protected: review.protected,
      }),
      ...(review.kind === 'jobs'
        ? [t('replies:archive.bulk_active_jobs', { active: review.active })]
        : []),
      t(`replies:archive.bulk_effect_${review.kind}`),
      t('replies:archive.bulk_snapshot'),
      ...(review.eligible === 0
        ? [t('replies:archive.bulk_empty')]
        : [t('replies:archive.bulk_expiry', { expiry: date(review.expiresAt, 'R') })]),
    ].join('\n'),
    components: rows([
      ...(review.eligible === 0
        ? []
        : [manageButton('bulk-confirm', review.reviewId, t('replies:archive.bulk_confirm'), true)]),
      manageBack(review.kind, t),
    ]),
  });
};

export const archiveBulkProgressReply = (
  progress: Progress,
  bot: BaseBot,
  finished: boolean,
): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  return archiveBulkPublicReply({
    content: [
      t(`replies:archive.bulk_${finished ? 'finished' : 'running'}`),
      t(`replies:archive.bulk_review_${progress.kind}`),
      t('replies:archive.bulk_progress_counts', {
        total: progress.total,
        deleted: progress.deleted,
        pending: progress.pending,
        protected: progress.protected,
        failed: progress.failed,
        remaining: progress.remaining,
      }),
      ...(progress.pending > 0 ? [t('replies:archive.bulk_submitted_stops')] : []),
      ...(progress.failed > 0 ? [t('replies:archive.bulk_retry_failed')] : []),
      ...(!finished ? [t('replies:archive.bulk_updated', { time: date(Date.now(), 'T') })] : []),
      t('replies:archive.manage_preserve_data'),
    ].join('\n'),
    components: rows([
      ...(!finished || !progress.complete
        ? [manageButton('bulk-confirm', progress.reviewId, t('replies:archive.bulk_resume'))]
        : [manageButton('bulk-result', progress.reviewId, t('replies:archive.bulk_result'))]),
      manageBack(progress.kind, t),
    ]),
  });
};
