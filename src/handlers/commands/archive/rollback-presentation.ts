import type { BoundTranslate } from '../../../core/i18n';
import { collectionName } from './operation-presentation';
import { date, escapeArchiveText, type Confirmation } from './presentation-common';

/** Historical operation counts describe candidate inverses, never current eligibility. */
export const rollbackSummaryLines = (
  confirmation: Confirmation,
  t: BoundTranslate,
  guildLabel: string,
): string[] => {
  const { run, summary } = confirmation;
  return [
    t('commands:archive_ui.rollback_title'),
    t('commands:archive_ui.scope', {
      guild: escapeArchiveText(guildLabel),
      cutoff: run.cutoff > 0 ? date(run.cutoff) : t('commands:archive_ui.unavailable'),
    }),
    t('commands:archive_ui.rollback_original', {
      count:
        summary.status === 'available'
          ? summary.totalOperations
          : t('commands:archive_ui.unavailable'),
    }),
    ...(summary.status === 'available' && summary.recordTypes !== undefined
      ? summary.recordTypes
          .filter((entry) => entry.operations > 0)
          .map((entry) =>
            t('commands:archive_ui.rollback_type', {
              target: collectionName(entry.collection, t),
              effects: [
                ...(entry.insertOperations > 0
                  ? [
                      t(
                        entry.collection === 'archive_revisions'
                          ? 'commands:archive_ui.rollback_retain_revisions'
                          : 'commands:archive_ui.rollback_remove',
                        { count: entry.insertOperations },
                      ),
                    ]
                  : []),
                ...(entry.updateOperations > 0
                  ? [
                      t('commands:archive_ui.rollback_restore_update', {
                        count: entry.updateOperations,
                      }),
                    ]
                  : []),
                ...(entry.deleteOperations > 0
                  ? [
                      t('commands:archive_ui.rollback_restore_delete', {
                        count: entry.deleteOperations,
                      }),
                    ]
                  : []),
                ...(entry.unknownImpactOperations > 0
                  ? [
                      t('commands:archive_ui.mutation_unknown', {
                        count: entry.unknownImpactOperations,
                      }),
                    ]
                  : []),
              ].join(', '),
            }),
          )
      : [t('commands:archive_ui.record_types_unavailable')]),
    t('commands:archive_ui.rollback_eligible_unknown'),
    ...(run.expiresAt === undefined
      ? []
      : [
          t('replies:archive.plan_recovery_expiry', {
            date: date(run.expiresAt),
            relative: date(run.expiresAt, 'R'),
          }),
        ]),
  ];
};
