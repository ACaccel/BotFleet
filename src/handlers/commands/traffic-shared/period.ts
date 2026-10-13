/**
 * The time frame of a `/traffic` reply: the current window ending now, the
 * equal-length window before it, and the trend granularity. Windows are
 * half-open `[startMs, endMs)`; trend, heat map and day labels use the bot's
 * `config.timeZone`, like the statistics reader.
 *
 * `24h` is a rolling window. Day ranges start at local midnight, so `7d` is the
 * last seven local days with today as the seventh (seven trend points, today
 * partial); the previous window is the same span shifted back by the range.
 */
import { localSlotOf, type StatsGranularity, type StatsWindow } from '../../../core/archive/stats';

import type { TrafficRange } from './types';

const DAY_MS = 86_400_000;

const RANGE_DAYS: Readonly<Record<TrafficRange, number>> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

const GRANULARITY: Readonly<Record<TrafficRange, StatsGranularity>> = {
  '24h': 'hour',
  '7d': 'day',
  '30d': 'day',
  '90d': 'day',
  '365d': 'week',
};

export interface Period {
  readonly range: TrafficRange;
  readonly window: StatsWindow;
  readonly previous: StatsWindow;
  readonly granularity: StatsGranularity;
  /** Length of the window in days (1 for `24h`). */
  readonly days: number;
  /** IANA zone from the bot's `config.timeZone`. */
  readonly timeZone: string;
}

/** Milliseconds the zone is ahead of UTC at `atMs`. */
const zoneOffsetMs = (timeZone: string, atMs: number): number => {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  for (const part of format.formatToParts(atMs)) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return asUtc - Math.floor(atMs / 60_000) * 60_000;
};

/** Local midnight starting the day `daysBack` days before the one containing `atMs`. */
const localMidnight = (atMs: number, daysBack: number, timeZone: string): number => {
  const [year, month, day] = localSlotOf(atMs, timeZone).dayKey.split('-').map(Number);
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - daysBack);
  // Two passes settle a midnight next to a daylight-saving change.
  const first = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, first);
};

export const resolvePeriod = (range: TrafficRange, nowMs: number, timeZone: string): Period => {
  const days = RANGE_DAYS[range];
  const startMs =
    range === '24h' ? nowMs - days * DAY_MS : localMidnight(nowMs, days - 1, timeZone);
  const shift = days * DAY_MS;
  return {
    range,
    window: { startMs, endMs: nowMs },
    previous: { startMs: startMs - shift, endMs: nowMs - shift },
    granularity: GRANULARITY[range],
    days,
    timeZone,
  };
};
