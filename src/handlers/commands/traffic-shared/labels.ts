/**
 * Date, time and change labels for `/traffic` replies. Dates and times are
 * digits only (`10/09`, `21:00`); words such as weekday and range names come
 * from the `replies:traffic` catalog.
 */
import { localSlotOf, type StatsGranularity } from '../../../core/archive/stats';

import type { Period } from './period';
import type { TFn, TrafficRange } from './types';

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const rangeLabel = (t: TFn, range: TrafficRange): string =>
  t(`replies:traffic.range.${range}`);

/** Weekday names, Monday first, at most two CJK characters each (`週一`, `Mon`). */
export const weekdayLabels = (t: TFn): string[] =>
  WEEKDAY_KEYS.map((key) => t(`replies:traffic.weekday.${key}`));

/** 0 = Monday … 6 = Sunday for a `YYYY-MM-DD` key. */
export const weekdayOf = (dayKey: string): number =>
  (new Date(`${dayKey.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7;

/** `YYYY-MM-DD…` to `MM/DD`. */
export const monthDay = (key: string): string => `${key.slice(5, 7)}/${key.slice(8, 10)}`;

/** `M/DD` for a dense axis (`9/10`, `10/01`). */
const axisDate = (key: string): string => `${Number(key.slice(5, 7))}/${key.slice(8, 10)}`;

/** A trend bucket key as an axis label: `21:00` for hours, `M/DD` otherwise. */
export const bucketLabel = (key: string, granularity: StatsGranularity): string =>
  granularity === 'hour' ? `${key.slice(11, 13)}:00` : axisDate(key);

/** Up to this many daily points, each axis label also names its weekday. */
const WEEKDAY_AXIS_POINTS = 8;

/** Axis labels of a trend: daily ranges up to a week add the short weekday (`10/03 六`). */
export const trendLabels = (
  t: TFn,
  keys: readonly string[],
  granularity: StatsGranularity,
): string[] => {
  if (granularity !== 'day' || keys.length > WEEKDAY_AXIS_POINTS)
    return keys.map((key) => bucketLabel(key, granularity));
  return keys.map(
    (key) =>
      `${monthDay(key)} ${t(`replies:traffic.weekday_short.${WEEKDAY_KEYS[weekdayOf(key)] ?? 'mon'}`)}`,
  );
};

/** Local `MM/DD HH:mm` of a timestamp. */
export const localDateTime = (timestampMs: number, timeZone: string): string => {
  const slot = localSlotOf(timestampMs, timeZone);
  const minute = new Intl.DateTimeFormat('en-GB', { timeZone, minute: '2-digit' })
    .format(timestampMs)
    .padStart(2, '0');
  return `${monthDay(slot.dayKey)} ${String(slot.hour).padStart(2, '0')}:${minute}`;
};

/** Local `MM/DD` of a timestamp. */
export const localDate = (timestampMs: number, timeZone: string): string =>
  monthDay(localSlotOf(timestampMs, timeZone).dayKey);

/**
 * The window's local dates: `09/10 – 10/09`, with times for `24h` and years for
 * `365d`.
 */
export const windowSpan = (
  window: Period['window'],
  range: TrafficRange,
  timeZone: string,
): string => {
  if (range === '24h')
    return `${localDateTime(window.startMs, timeZone)} – ${localDateTime(window.endMs, timeZone)}`;
  const first = localSlotOf(window.startMs, timeZone);
  const last = localSlotOf(window.endMs - 1, timeZone);
  if (range === '365d') {
    const full = (key: string): string => key.replaceAll('-', '/');
    return `${full(first.dayKey)} – ${full(last.dayKey)}`;
  }
  return `${monthDay(first.dayKey)} – ${monthDay(last.dayKey)}`;
};

/** `UTC+8`, `UTC-3:30` or `UTC` for the zone's offset at `atMs`. */
export const zoneLabel = (timeZone: string, atMs: number): string => {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(atMs)
    .find((entry) => entry.type === 'timeZoneName')?.value;
  return (part ?? 'GMT').replace('GMT', 'UTC');
};

/** Relative change in percent, or `undefined` without a previous value. */
export const percentChange = (current: number, previous: number): number | undefined =>
  previous > 0 ? ((current - previous) / previous) * 100 : undefined;

/** `+8.2%`, `-3.0%` or `0.0%`. */
export const signedPercent = (change: number): string => {
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
};
