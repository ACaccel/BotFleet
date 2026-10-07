import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveBrowsePage, ArchiveNavigationActor } from './navigation';
import type { ArchiveOperationSummary } from '../../../core/archive/manifest-target';
import { categoryName, type Manifest } from './presentation-common';
import {
  collectionName,
  operationAction,
  operationEffect,
  operationSource,
  operationState,
} from './operation-presentation';
import { fitItems, withoutPaging, navigationRows } from './manifest-page-common';

const changeLines = (
  operation: ArchiveOperationSummary,
  report: Manifest,
  bot: BaseBot,
  t: BoundTranslate,
): string =>
  [
    operationSource(operation, report.run, bot, t, 35),
    t('commands:archive_ui.action_target', {
      action: operationAction(operation, t),
      target: collectionName(operation.collection, t),
    }),
    t('commands:archive_ui.impact', { effect: operationEffect(operation, t) }),
    ...(operation.state === 'conflict'
      ? [t('commands:archive_ui.state', { state: operationState(operation.state, t) })]
      : []),
  ].join('\n');

export const renderOperations = (
  runId: string,
  report: Manifest,
  bot: BaseBot,
  actor: ArchiveNavigationActor,
  page: ArchiveBrowsePage,
  t: BoundTranslate,
): InteractionReplyOptions => {
  const heading = t('replies:archive.changes_heading', {
    category: categoryName(t, page.category),
  });
  const visible = fitItems(
    report.operations,
    (operation) => changeLines(operation, report, bot, t),
    heading.length + 180,
  );
  const first = visible.items.at(0);
  const last = visible.items.at(-1);
  const hasNext = report.hasNext || visible.items.length < report.operations.length;
  const base = withoutPaging(page);
  const previous =
    report.hasPrevious && first !== undefined
      ? { ...base, beforeSequence: first.sequence }
      : undefined;
  const next =
    hasNext && last !== undefined ? { ...base, afterSequence: last.sequence } : undefined;
  return {
    content: [heading, visible.text || t('replies:archive.changes_none')].join('\n\n'),
    components: navigationRows(runId, actor, page, t, previous, next),
  };
};
