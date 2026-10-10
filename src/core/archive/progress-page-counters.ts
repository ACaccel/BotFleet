import type { Translator } from '../i18n';
import type { ArchiveProgressSnapshot } from './progress';

const number = (value: number): string =>
  Math.max(0, value).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Message metrics are meaningful only for message work or recorded message outcomes. */
export const archiveProgressPageCounters = (
  snapshot: ArchiveProgressSnapshot,
  translator: Translator,
): string[] => {
  const t = (key: string, values?: Record<string, string | number>): string =>
    translator.t(`replies:archive.view_${key}`, values);
  const messageWork =
    ['apply', 'resume', 'periodic'].includes(snapshot.work) ||
    Object.values(snapshot.messages).some((count) => count > 0) ||
    snapshot.sources.total > 0;
  if (!messageWork) {
    const phase = snapshot.phases[snapshot.phase];
    return [
      phase.quality === 'unknown' && phase.scanned === 0 && phase.committed === 0
        ? t('counts_unavailable')
        : t('detail_phase_count', {
            count: number(phase.unit === 'documents' ? phase.scanned : phase.committed),
            unit: t(`unit_${phase.unit}`),
          }),
    ];
  }
  const unavailable =
    snapshot.messageCountQuality === 'lower-bound' &&
    Object.values(snapshot.messages).every((count) => count === 0) &&
    snapshot.sources.total === 0;
  const lines = [
    unavailable
      ? t('counts_unavailable')
      : t(
          snapshot.messageClassificationVersion === 2
            ? 'classified_detail_counts'
            : 'detail_counts',
          {
            sources: number(snapshot.sources.completed),
            messages: number(snapshot.messages.scanned),
            inserted: number(snapshot.messages.inserted),
            updated: number(snapshot.messages.updated),
            upgraded: number(snapshot.messages.upgraded ?? 0),
          },
        ),
  ];
  if (
    !unavailable &&
    snapshot.messageClassificationVersion !== 2 &&
    (snapshot.messages.upgraded ?? 0) > 0
  )
    lines.push(t('known_upgrades', { count: number(snapshot.messages.upgraded!) }));
  if (!unavailable) {
    if (snapshot.messageCountQuality === 'lower-bound') lines.push(t('counts_lower_bound'));
  }
  if (snapshot.phases.repair.unit === 'operations' && snapshot.phases.repair.committed > 0)
    lines.push(
      translator.t('replies:archive.public_operations_confirmed', {
        count: number(snapshot.phases.repair.committed),
        unit: t('unit_operations'),
      }),
    );
  if (snapshot.reactionCountKnown === false) lines.push(t('reactions_unrecorded'));
  else if (snapshot.reactions.required > 0)
    lines.push(
      t('reaction_summary', {
        count: number(snapshot.reactions.completed),
        total: number(snapshot.reactions.required),
      }),
    );
  return lines;
};
