import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveManifestSummary } from '../../../core/archive/manifest-summary';
import { collectionName, operationImpactCounts } from './operation-presentation';
import {
  categoryName,
  date,
  escapeArchiveText,
  runStates,
  type Manifest,
} from './presentation-common';

export const summaryLines = (
  run: Manifest['run'],
  summary: ArchiveManifestSummary,
  t: BoundTranslate,
  guildLabel?: string,
): string[] => {
  const planning = ['planning', 'planned', 'partial-plan', 'failed-plan'].includes(run.status);
  const lines = [
    planning
      ? t('commands:archive_ui.plan_not_applied', {
          state: t(
            `replies:archive.run_state_${runStates.has(run.status) ? run.status : 'unknown'}`,
          ),
        })
      : t('replies:archive.plan_title', {
          state: t(
            `replies:archive.run_state_${runStates.has(run.status) ? run.status : 'unknown'}`,
          ),
        }),
    t('commands:archive_ui.scope', {
      guild: escapeArchiveText(guildLabel ?? run.guildId ?? t('commands:archive_ui.unavailable')),
      cutoff: run.cutoff > 0 ? date(run.cutoff) : t('commands:archive_ui.unavailable'),
    }),
    ...(planning && run.scope?.policy === 'unavailable'
      ? [t('commands:archive_ui.policy_unavailable')]
      : []),
    ...(run.scope?.timestampsOnly === true
      ? [t('commands:archive_ui.timestamps_only')]
      : [t(`commands:archive_ui.history_scope_${run.scope?.historyDiscovery ?? 'unknown'}`)]),
  ];
  if (summary.status !== 'available') lines.push(t('replies:archive.plan_summary_unavailable'));
  else {
    lines.push(
      t('commands:archive_ui.existing_scope', {
        sources: summary.targets?.distinctSources ?? t('commands:archive_ui.unavailable'),
        operations: summary.totalOperations,
      }),
    );
    if (
      summary.targets?.unknownSourceOperations !== undefined &&
      summary.targets.unknownSourceOperations > 0
    )
      lines.push(
        t('commands:archive_ui.identity_unavailable', {
          count: summary.targets.unknownSourceOperations,
        }),
      );
    const categories = summary.categories.filter((entry) => entry.operations > 0);
    for (const entry of summary.recordTypes === undefined ? categories : [])
      lines.push(
        t('commands:archive_ui.summary_category', {
          category: categoryName(t, entry.category),
          operations: entry.operations,
          effects: summary.recordTypes === undefined ? ` · ${operationImpactCounts(entry, t)}` : '',
        }),
      );
    if (summary.recordTypes === undefined) {
      if (summary.impacts.deleteOperations > 0 || summary.impacts.unknownImpactOperations > 0)
        lines.push(t('commands:archive_ui.record_types_unavailable'));
    } else {
      for (const entry of summary.recordTypes.filter((record) => record.operations > 0))
        lines.push(
          t('commands:archive_ui.record_type_impact', {
            target: collectionName(entry.collection, t),
            effects: operationImpactCounts(entry, t),
          }),
        );
    }
    if (planning) {
      const resets = categories.some(
        (entry) => entry.category === 'reset-progress' && entry.updateOperations > 0,
      );
      const duplicates = categories.some(
        (entry) => entry.category === 'remove-duplicate-progress' && entry.deleteOperations > 0,
      );
      if (resets || duplicates)
        lines.push(
          t(
            `commands:archive_ui.effect_${resets && duplicates ? 'progress_combined' : resets ? 'reset-progress' : 'remove-duplicate-progress'}`,
          ),
        );
      if (categories.some((entry) => entry.category === 'quarantine-data'))
        lines.push(t('commands:archive_ui.effect_quarantine-data'));
    }
    if (
      categories.some((entry) => entry.category === 'unknown') ||
      summary.impacts.unknownImpactOperations > 0
    )
      lines.push(t('commands:archive_ui.effect_unknown'));
    if (summary.totalOperations === 0 && planning)
      lines.push(t('replies:archive.plan_zero_operations'));
    if (
      summary.totalOperations > 0 &&
      summary.recordTypes !== undefined &&
      summary.recordTypes.length > 0 &&
      summary.recordTypes.every((entry) => entry.collection === 'fetches') &&
      summary.recordTypes.every((entry) => entry.unknownImpactOperations === 0)
    )
      lines.push(t('commands:archive_ui.progress_only'));
    if (run.unresolved > 0 || run.issueCount > 0)
      lines.push(
        t(`commands:archive_ui.${planning ? 'plan_issues' : 'historical_issues'}`, {
          unresolved: run.unresolved,
          issues: run.issueCount,
        }),
      );
  }
  if (planning && run.unresolved === 0 && run.issueCount === 0)
    lines.push(t('commands:archive_ui.plan_not_verified'));
  if (['planned', 'partial-plan'].includes(run.status))
    lines.push(
      run.validUntil === undefined
        ? t('replies:archive.plan_no_expiry')
        : t('commands:archive_ui.start_expiry', {
            date: date(run.validUntil),
            relative: date(run.validUntil, 'R'),
          }),
    );
  if (run.expiresAt !== undefined)
    lines.push(
      t('replies:archive.plan_recovery_expiry', {
        date: date(run.expiresAt),
        relative: date(run.expiresAt, 'R'),
      }),
    );
  return lines;
};
