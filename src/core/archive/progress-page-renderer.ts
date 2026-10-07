import type { Translator } from '../i18n';
import type { ArchiveProgressSnapshot } from './progress';
import { archiveProgressPageCounters } from './progress-page-counters';

interface PageOptions {
  target?: string;
  sourceLabels?: Readonly<Record<string, string>>;
  contextLines?: readonly string[];
  footerLines?: readonly string[];
}
const escape = (text: string): string =>
  text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1').replace(/@/g, '@\u200b');
const number = (value: number): string =>
  Math.max(0, value).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Detail pages retain fetched source entries and navigation within the display budget. */
export const renderArchiveProgressPage = (
  snapshot: ArchiveProgressSnapshot,
  translator: Translator,
  options: PageOptions,
): string => {
  const t = (key: string, values?: Record<string, string | number>): string =>
    translator.t(`replies:archive.view_${key}`, values);
  const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(snapshot.state);
  const lines = [
    t('title', { work: t(`work_${snapshot.work}`), state: t(`state_${snapshot.state}`) }),
  ];
  if (options.target !== undefined) lines.push(t('target', { target: escape(options.target) }));
  lines.push(t('phase', { phase: t(`phase_${snapshot.phase}`) }));
  if (['apply', 'resume', 'verify', 'accept', 'periodic'].includes(snapshot.work))
    lines.push(
      snapshot.cutoffKnown === false
        ? t('cutoff_unknown')
        : t('cutoff', { time: `<t:${Math.floor(Date.parse(snapshot.cutoff) / 1000)}:f>` }),
    );
  if (terminal && ['apply', 'resume', 'verify', 'accept'].includes(snapshot.work)) {
    lines.push(t(`validation_${snapshot.validation?.state ?? 'unavailable'}`));
    if (snapshot.validation?.coverage !== undefined)
      lines.push(t(`coverage_${snapshot.validation.coverage}`));
    if (snapshot.validation?.recoveryExpiresAt !== undefined)
      lines.push(
        t('recovery_expiry', {
          time: `<t:${Math.floor(snapshot.validation.recoveryExpiresAt / 1000)}:f>`,
        }),
      );
    if (snapshot.state === 'complete' && snapshot.work !== 'accept') lines.push(t('detail_accept'));
  }
  if (snapshot.state === 'cancelling' || snapshot.state === 'cancelled')
    lines.push(t('cancelled_writes'));
  if (snapshot.work === 'rollback') {
    lines.push(t('rollback_impact'));
    if (snapshot.outcomes !== undefined) lines.push(t('rollback', snapshot.outcomes));
  }
  if (snapshot.work === 'refresh-attachment')
    lines.push(
      t(
        snapshot.state === 'complete'
          ? 'attachment_complete'
          : terminal
            ? 'attachment_incomplete'
            : 'attachment_pending',
      ),
    );
  if (snapshot.work === 'accept' && snapshot.state === 'complete') lines.push(t('next_accepted'));
  lines.push(...archiveProgressPageCounters(snapshot, translator));
  const source = (id: string | undefined, name?: string): string => {
    const label = id === undefined ? undefined : options.sourceLabels?.[id];
    return escape(
      label !== undefined && label.length <= 180
        ? label
        : t('detail_source', {
            name: name?.slice(0, 12) || t('source_unknown_identity', { id: id ?? t('unknown') }),
            id: id ?? t('unknown'),
          }),
    );
  };
  lines.push(...(options.contextLines ?? []));
  for (const activity of snapshot.activities)
    lines.push(
      t('activity_summary', {
        source: source(activity.sourceId, activity.name),
        step: t(`step_${activity.step}`),
      }),
    );
  for (const gap of snapshot.gaps)
    lines.push(
      t('scope_row', {
        source: source(gap.sourceId, gap.name),
        reason: t(`detail_gap_${gap.reason}`),
      }),
    );
  if (snapshot.activities.length === 0 && snapshot.gaps.length === 0) lines.push(t('detail_empty'));
  const navigation = options.footerLines ?? [];
  const required = [...lines, ...navigation];
  const optional = snapshot.activities.flatMap((activity) => [
    ...(!activity.provisional || activity.pageTotal === undefined
      ? []
      : [
          t('provisional', {
            count: number(activity.pageProcessed ?? 0),
            total: number(activity.pageTotal),
          }),
        ]),
  ]);
  for (const line of optional)
    if ([...required, line].join('\n').length <= 1900) required.splice(lines.length, 0, line);
  const result = required.join('\n');
  if (result.length > 1900)
    throw new Error('Archive detail page exceeded its bounded display budget');
  return result;
};
