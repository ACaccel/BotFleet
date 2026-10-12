/**
 * Activity tiles and sections built from one report: the busiest bucket,
 * member retention, content types, the heat map, and the "N others" notes
 * under rankings.
 */
import type {
  ActivityHeatmap,
  ActivitySummary,
  RetentionStats,
  TrendBucket,
} from '../../../persistence/repositories/archive-stats.types';

import { tCount } from './activity-common';
import {
  formatCount,
  formatPercent,
  type BarRow,
  type HeatmapSection,
  type StatTile,
} from './dashboard';
import { bucketLabel, monthDay, weekdayLabels, weekdayOf, zoneLabel } from './labels';
import type { Period } from './period';
import type { TFn } from './types';

const K = 'replies:traffic';

/** The busiest trend bucket: a day (with weekday), an hour for `24h`, a week for `365d`. */
export const busiestTile = (t: TFn, period: Period, buckets: readonly TrendBucket[]): StatTile => {
  const top = buckets.reduce<TrendBucket | undefined>(
    (best, bucket) => (best === undefined || bucket.messages > best.messages ? bucket : best),
    undefined,
  );
  if (top === undefined || top.messages === 0) return { label: t(`${K}.busiest`), value: '—' };
  const weekday = weekdayLabels(t)[weekdayOf(top.key)] ?? '';
  const sub =
    period.granularity === 'day'
      ? tCount(t, `${K}.busiest_day_sub`, top.messages, { weekday })
      : tCount(t, `${K}.busiest_${period.granularity}_sub`, top.messages);
  const value = period.granularity === 'hour' ? bucketLabel(top.key, 'hour') : monthDay(top.key);
  return { label: t(`${K}.busiest`), value, sub };
};

/** Retention and returning tiles, one tile row of the narrow summary column. */
export const retentionTiles = (t: TFn, retention: RetentionStats): StatTile[] => [
  {
    label: t(`${K}.retention`),
    value:
      retention.retentionRate === null
        ? '—'
        : formatPercent(retention.retained, retention.previousMembers),
    sub: tCount(t, `${K}.retention_sub`, retention.previousMembers, {
      retained: formatCount(retention.retained),
    }),
    flex: 1.2,
  },
  {
    label: t(`${K}.returning`),
    value: formatCount(retention.returningOrNew),
    sub: t(`${K}.returning_sub`, {
      percent: formatPercent(retention.returningOrNew, retention.currentMembers),
    }),
  },
];

const CONTENT_KEYS = ['media', 'links', 'stickers', 'files', 'voice', 'polls'] as const;

/** Content categories with at least one message, largest first. */
export const contentRows = (t: TFn, content: ActivitySummary['content']): BarRow[] =>
  CONTENT_KEYS.map((key) => ({ label: t(`${K}.content.${key}`), value: content[key] }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

/** The weekday x hour heat map; omitted for `24h`, where one day says little. */
export const heatmapOf = (
  t: TFn,
  period: Period,
  heatmap: ActivityHeatmap | undefined,
  titleKey = `${K}.heatmap.title`,
  /** Legend after the ramp; its unit names what a cell counts. */
  moreKey = `${K}.heatmap.more`,
): HeatmapSection | undefined => {
  if (heatmap === undefined || period.range === '24h') return undefined;
  const zone = zoneLabel(period.timeZone, period.window.endMs);
  return {
    title: t(titleKey),
    grid: heatmap.cells,
    weekdayLabels: weekdayLabels(t),
    lessLabel: t(`${K}.heatmap.less`),
    moreLabel: (max) => t(moreKey, { max }),
    peakLabel: (weekday, hour) => t(`${K}.heatmap.peak`, { weekday, hour, zone }),
  };
};

/** "27 other channels, 2,611 messages" under a ranking, or nothing when all rows fit. */
export const restNote = (
  t: TFn,
  itemsKey: string,
  rest: number,
  restMessages: number,
): string | undefined =>
  rest > 0
    ? t(`${K}.rest`, {
        items: tCount(t, `${K}.${itemsKey}`, rest),
        messages: tCount(t, `${K}.messages_count`, Math.max(0, restMessages)),
      })
    : undefined;
