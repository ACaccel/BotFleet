import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import type { ArchiveBrowsePage, ArchiveNavigationActor } from './navigation';
import type { ArchiveManifestGroup } from '../../../core/archive/manifest-target';
import { archiveSourceLabel } from './source-presentation';
import { categoryName, escapeArchiveText, type Manifest } from './presentation-common';
import { collectionName, operationAction, operationEffect } from './operation-presentation';
import {
  pageLimit,
  statesLine,
  fitItems,
  withoutPaging,
  navigationRows,
} from './manifest-page-common';

export const renderGroups = async (
  runId: string,
  report: Manifest,
  bot: BaseBot,
  control: ArchiveControlService,
  actor: ArchiveNavigationActor,
  page: ArchiveBrowsePage,
  t: BoundTranslate,
): Promise<InteractionReplyOptions> => {
  const data = await control.manifestGroups(runId, {
    limit: pageLimit(page),
    ...(page.category === undefined ? {} : { category: page.category }),
    ...(page.afterGroup === undefined ? {} : { afterGroup: page.afterGroup }),
    ...(page.beforeGroup === undefined ? {} : { beforeGroup: page.beforeGroup }),
  });
  const heading = t('replies:archive.changes_heading', {
    category: categoryName(t, page.category),
  });
  const render = (group: ArchiveManifestGroup): string => {
    const examples = group.examples
      .slice(0, 3)
      .map((target) =>
        escapeArchiveText(
          archiveSourceLabel(target, bot.client?.guilds?.cache.get(report.run.guildId), t, 24),
        ),
      );
    return [
      t('commands:archive_ui.group_title', {
        action: operationAction(group, t),
        target: collectionName(group.collection, t),
      }),
      t('commands:archive_ui.group_counts', {
        operations: group.operations,
        sources: group.sourceCount ?? t('commands:archive_ui.unavailable'),
      }),
      t('commands:archive_ui.impact', { effect: operationEffect(group, t) }),
      ...(group.states['conflict'] ? [statesLine({ conflict: group.states['conflict'] }, t)] : []),
      ...(examples.length === 0
        ? []
        : [t('commands:archive_ui.examples', { sources: examples.join('; ') })]),
      ...(group.sourceCount > examples.length
        ? [t('commands:archive_ui.more_sources', { count: group.sourceCount - examples.length })]
        : []),
      ...(group.unknownSourceOperations > 0
        ? [t('commands:archive_ui.identity_unavailable', { count: group.unknownSourceOperations })]
        : []),
    ].join('\n');
  };
  const visible = fitItems(data.groups, render, heading.length + 220);
  const last = visible.items.at(-1);
  const first = visible.items.at(0);
  const base = withoutPaging(page);
  const hasNext = data.hasNext || visible.items.length < data.groups.length;
  const previous =
    data.hasPrevious && first !== undefined ? { ...base, beforeGroup: first.key } : undefined;
  const next = hasNext && last !== undefined ? { ...base, afterGroup: last.key } : undefined;
  return {
    content: [
      heading,
      data.status === 'unavailable'
        ? t('commands:archive_ui.statistics_unavailable')
        : t('commands:archive_ui.filtered_total', { operations: data.totalOperations }),
      visible.text || (data.status === 'available' ? t('replies:archive.changes_none') : ''),
    ]
      .filter(Boolean)
      .join('\n\n'),
    components: navigationRows(runId, actor, page, t, previous, next),
  };
};
