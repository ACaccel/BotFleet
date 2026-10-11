/**
 * Pieces every activity report shares: plural-aware counts, the hero tile with
 * its change against the previous period, the summary delta, and the trend.
 */
import type { TrendBucket } from '../../../persistence/repositories/archive-stats.types';

import {
  formatCount,
  type Delta,
  type HeroMetric,
  type HeroTile,
  type TrendSection,
} from './dashboard';
import { percentChange, signedPercent, trendLabels, windowSpan } from './labels';
import type { Period } from './period';
import type { TrafficContext } from './run';
import type { TFn } from './types';

const K = 'replies:traffic';

/** `t` for a count-bearing key: `count` picks the plural form, `number` is the formatted count. */
export const tCount = (
  t: TFn,
  key: string,
  count: number,
  params: Record<string, string> = {},
): string => t(key, { ...params, count, number: formatCount(count) });

const delta = (t: TFn, current: number, previous: number): Delta => {
  const change = percentChange(current, previous);
  const sub = t(`${K}.delta_previous`, { number: formatCount(previous) });
  if (change === undefined) return { direction: 'flat', text: '—', sub };
  const direction = change > 0.05 ? 'up' : change < -0.05 ? 'down' : 'flat';
  return { direction, text: `${Math.abs(change).toFixed(1)}%`, sub };
};

export const heroOf = (
  t: TFn,
  current: number,
  previous: number,
  metrics: readonly HeroMetric[],
  label = t(`${K}.messages`),
): HeroTile => ({
  label,
  value: formatCount(current),
  delta: delta(t, current, previous),
  metrics,
});

/** `(vs previous +8.2%)` after a summary count. */
export const summaryDelta = (t: TFn, current: number, previous: number): string => {
  const change = percentChange(current, previous);
  return change === undefined
    ? t(`${K}.summary_delta_none`)
    : t(`${K}.summary_delta`, { change: signedPercent(change) });
};

export const dailyAverage = (t: TFn, total: number, period: Period): HeroMetric => ({
  label: t(`${K}.daily_average`),
  value: formatCount(total / period.days),
});

export const trendOf = (
  t: TFn,
  period: Period,
  current: readonly TrendBucket[],
  previous: readonly TrendBucket[] | undefined,
  titleKey = `${K}.trend.${period.granularity}`,
): TrendSection => ({
  title: t(titleKey),
  currentLabel: t(`${K}.trend.current`),
  current: current.map((bucket) => bucket.messages),
  ...(previous === undefined
    ? {}
    : {
        previous: {
          label: t(`${K}.trend.previous`, {
            span: windowSpan(period.previous, period.range, period.timeZone),
          }),
          values: previous.map((bucket) => bucket.messages),
        },
      }),
  xLabels: trendLabels(
    t,
    current.map((bucket) => bucket.key),
    period.granularity,
  ),
});

/** The D8 note that statistics stay incomplete until a full backup completes. */
export const rebuildNote = (context: Pick<TrafficContext, 'rebuilding' | 't'>): string =>
  context.rebuilding ? context.t(`${K}.notes.rebuild`) : '';
