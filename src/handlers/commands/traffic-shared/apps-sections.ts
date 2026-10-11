/**
 * Sections of the `/traffic apps` dashboards: the interaction types (commands,
 * components, modals) in the segment colour order the dashboards use, the use
 * trend against the previous period, and the note naming the first record.
 */
import type { AppUsageStats } from '../../../persistence/repositories/archive-stats.types';

import { formatCount, formatPercent, type BarRow, type TrendSection } from './dashboard';
import { localDate, trendLabels, windowSpan } from './labels';
import type { Period } from './period';
import type { TFn } from './types';

const DAY_MS = 86_400_000;

const K = 'replies:traffic.apps.type';
const R = 'replies:traffic';
const TYPES = ['commands', 'components', 'modals'] as const;

type AppUsageRow = AppUsageStats['apps'][number];

export const appTypeLegend = (t: TFn): string[] => TYPES.map((type) => t(`${K}.${type}`));

/** "Commands 1,050 · Components 154", listing only the types used. */
export const appBreakdown = (t: TFn, row: AppUsageRow): string =>
  TYPES.filter((type) => row[type] > 0)
    .map((type) => t(`${K}_count.${type}`, { number: formatCount(row[type]) }))
    .join(' · ');

/** One bar per type with its count and share, for the single-app drill-down. */
export const appTypeRows = (t: TFn, row: AppUsageRow | undefined): BarRow[] =>
  TYPES.map((type) => {
    const value = row?.[type] ?? 0;
    return {
      label: t(`${K}.${type}`),
      value,
      valueText: t('replies:traffic.apps.type_share', {
        number: formatCount(value),
        percent: formatPercent(value, row?.uses ?? 0, 1),
      }),
    };
  });

export const usageTrend = (
  t: TFn,
  period: Period,
  usage: AppUsageStats,
  previous: AppUsageStats,
): TrendSection => {
  const buckets = usage.trend ?? [];
  return {
    title: t(`${R}.apps.trend.${period.granularity}`),
    currentLabel: t(`${R}.trend.current`),
    current: buckets.map((bucket) => bucket.uses),
    previous: {
      label: t(`${R}.trend.previous`, {
        span: windowSpan(period.previous, period.range, period.timeZone),
      }),
      values: (previous.trend ?? []).map((bucket) => bucket.uses),
    },
    xLabels: trendLabels(
      t,
      buckets.map((bucket) => bucket.key),
      period.granularity,
    ),
  };
};

/** Names the first record when the window starts before the archive has any. */
export const sinceNote = (t: TFn, period: Period, usage: AppUsageStats): string =>
  usage.firstRecordAt !== undefined && usage.firstRecordAt - period.window.startMs > DAY_MS
    ? t(`${R}.notes.apps_since`, { date: localDate(usage.firstRecordAt, period.timeZone) })
    : '';
