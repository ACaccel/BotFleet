import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import type { ArchiveBrowsePage, ArchiveNavigationActor } from './navigation';
import { browseButton, rows } from './presentation-common';
import { operationState } from './operation-presentation';

export const pageLimit = (page: ArchiveBrowsePage): number =>
  Math.max(1, Math.min(5, page.limit ?? 5));
export const manifestOptions = (
  page: ArchiveBrowsePage,
): NonNullable<Parameters<ArchiveControlService['manifest']>[1]> => ({
  limit: pageLimit(page),
  ...(page.category === undefined ? {} : { category: page.category }),
  ...(page.group === undefined ? {} : { group: page.group }),
  ...(page.sourceId === undefined ? {} : { sourceId: page.sourceId }),
  ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
  ...(page.beforeSequence === undefined ? {} : { beforeSequence: page.beforeSequence }),
});
export const statesLine = (states: Record<string, number>, t: BoundTranslate): string =>
  t('commands:archive_ui.states', {
    states: Object.entries(states)
      .map(([state, count]) => `${operationState(state, t)} ${count}`)
      .join(', '),
  });
export const withoutPaging = (page: ArchiveBrowsePage): ArchiveBrowsePage => {
  const {
    afterSequence: _a,
    beforeSequence: _b,
    afterGroup: _c,
    beforeGroup: _d,
    afterSource: _e,
    beforeSource: _f,
    ...base
  } = page;
  return base;
};
export const navigationRows = (
  runId: string,
  actor: ArchiveNavigationActor,
  _page: ArchiveBrowsePage,
  t: BoundTranslate,
  previous?: ArchiveBrowsePage,
  next?: ArchiveBrowsePage,
): ReturnType<typeof rows> =>
  rows([
    ...(previous === undefined
      ? []
      : [browseButton(runId, actor, previous, t('replies:archive.page_previous'))]),
    ...(next === undefined
      ? []
      : [browseButton(runId, actor, next, t('replies:archive.page_next'))]),
    browseButton(runId, actor, { view: 'summary' }, t('replies:archive.view_summary')),
  ]);
export const fitItems = <T>(
  items: readonly T[],
  render: (item: T) => string,
  reserved: number,
): { items: T[]; text: string } => {
  const visible: T[] = [];
  const lines: string[] = [];
  let length = reserved;
  for (const item of items.slice(0, 5)) {
    const line = render(item);
    if (visible.length > 0 && length + line.length + 2 > 1900) break;
    visible.push(item);
    lines.push(line);
    length += line.length + 2;
  }
  return { items: visible, text: lines.join('\n\n') };
};
