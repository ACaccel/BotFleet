import type { BaseBot } from '@bot';
import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveManifestImpact } from '../../../core/archive/manifest-summary';
import type { ArchiveOperationSummary } from '../../../core/archive/manifest-target';
import type { Manifest } from './presentation-common';
import { escapeArchiveText } from './presentation-common';
import { archiveSourceLabel } from './source-presentation';

const states = new Set(['planned', 'journaled', 'applied', 'verified', 'rolled-back', 'conflict']);
const reasons = new Set([
  'reset-cursor-for-full-reconciliation',
  'delete-duplicate-cursor',
  'rescue-timestamp',
  'merge-compatible-duplicate',
  'delete-verified-duplicate',
  'policy-excluded-source',
  'policy-excluded-related-record',
  'preserve-quarantine-evidence',
  'relocate-to-quarantine',
  'quarantine-invalid-cursor',
]);
const collections = new Set([
  'fetches',
  'messages',
  'archive_revisions',
  'archive_reactions',
  'archive_quarantine',
]);
export const operationState = (state: string, t: BoundTranslate): string =>
  t(`replies:archive.operation_state_${states.has(state) ? state : 'unknown'}`);
export const collectionName = (collection: string, t: BoundTranslate): string =>
  t(`commands:archive_ui.collection_${collections.has(collection) ? collection : 'unknown'}`);
export const operationAction = (
  operation: Pick<ArchiveOperationSummary, 'reason' | 'category'>,
  t: BoundTranslate,
): string =>
  operation.category !== 'unknown' && reasons.has(operation.reason)
    ? t(`replies:archive.change_reason_${operation.reason}`)
    : t(`replies:archive.category_${operation.category ?? 'unknown'}`);
export const operationEffect = (
  operation: Pick<ArchiveOperationSummary, 'reason' | 'collection' | 'impact' | 'category'>,
  t: BoundTranslate,
): string => {
  if (operation.impact === 'unknown') return t('commands:archive_ui.effect_unknown');
  if (operation.collection === 'fetches') {
    if (operation.category === 'reset-progress' && operation.impact === 'update')
      return t('commands:archive_ui.effect_progress_reset');
    if (operation.category === 'remove-duplicate-progress' && operation.impact === 'delete')
      return t('commands:archive_ui.effect_remove-duplicate-progress');
    return t(`commands:archive_ui.effect_progress_${operation.impact}`);
  }
  if (
    operation.category === 'quarantine-data' &&
    operation.reason === 'relocate-to-quarantine' &&
    operation.impact === 'delete'
  )
    return t('commands:archive_ui.effect_quarantine_move');
  if (
    operation.category === 'quarantine-data' &&
    operation.collection === 'archive_quarantine' &&
    operation.impact === 'insert'
  )
    return t('commands:archive_ui.effect_quarantine_evidence');
  return t(`commands:archive_ui.effect_record_${operation.impact}`, {
    target: collectionName(operation.collection, t),
  });
};
export const operationSource = (
  operation: Pick<ArchiveOperationSummary, 'target'>,
  run: Manifest['run'],
  bot: BaseBot,
  t: BoundTranslate,
  maxNameLength = 45,
): string =>
  escapeArchiveText(
    archiveSourceLabel(
      operation.target ?? { identity: 'unknown' },
      bot.client?.guilds?.cache.get(run.guildId),
      t,
      maxNameLength,
    ),
  );
export const operationImpactCounts = (entry: ArchiveManifestImpact, t: BoundTranslate): string =>
  [
    ...(entry.insertOperations > 0
      ? [t('commands:archive_ui.mutation_insert', { count: entry.insertOperations })]
      : []),
    ...(entry.updateOperations > 0
      ? [t('commands:archive_ui.mutation_update', { count: entry.updateOperations })]
      : []),
    ...(entry.deleteOperations > 0
      ? [t('commands:archive_ui.mutation_delete', { count: entry.deleteOperations })]
      : []),
    ...(entry.unknownImpactOperations > 0
      ? [t('commands:archive_ui.mutation_unknown', { count: entry.unknownImpactOperations })]
      : []),
  ].join(', ');
