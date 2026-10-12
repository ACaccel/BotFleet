/**
 * Unit coverage for the `/traffic` time frame and labels: window lengths and
 * granularity per range, local date spans in the host zone, axis labels, the
 * zone caption and the relative change.
 */
import { describe, expect, it } from 'vitest';

import { bucketKeysOf } from '../../../../src/core/archive/stats';
import {
  bucketLabel,
  localDateTime,
  percentChange,
  trendLabels,
  weekdayOf,
  windowSpan,
  zoneLabel,
} from '../../../../src/handlers/commands/traffic-shared/labels';
import { resolvePeriod } from '../../../../src/handlers/commands/traffic-shared/period';

const NOW = Date.UTC(2026, 9, 9, 7, 24); // 2026-10-09 15:24 in Asia/Taipei
const TZ = 'Asia/Taipei';
const DAY = 86_400_000;

describe('resolvePeriod', () => {
  it('keeps 24h rolling, by hour', () => {
    const period = resolvePeriod('24h', NOW, TZ);
    expect(period.granularity).toBe('hour');
    expect(period.window).toEqual({ startMs: NOW - DAY, endMs: NOW });
    expect(period.previous).toEqual({ startMs: NOW - 2 * DAY, endMs: NOW - DAY });
  });

  it.each([
    ['7d', 7, 'day', Date.UTC(2026, 9, 2, 16)],
    ['30d', 30, 'day', Date.UTC(2026, 8, 9, 16)],
    ['365d', 365, 'week', Date.UTC(2025, 9, 9, 16)],
  ] as const)(
    '%s starts at local midnight %d days back including today, by %s',
    (range, days, granularity, startMs) => {
      const period = resolvePeriod(range, NOW, TZ);
      expect(period.days).toBe(days);
      expect(period.granularity).toBe(granularity);
      expect(period.window).toEqual({ startMs, endMs: NOW });
      expect(period.previous).toEqual({
        startMs: startMs - days * DAY,
        endMs: NOW - days * DAY,
      });
    },
  );

  it('gives 7d exactly seven daily points with today last', () => {
    const keys = bucketKeysOf(resolvePeriod('7d', NOW, TZ).window, 'day', TZ);
    expect(keys).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
  });

  it('finds local midnight across a daylight-saving change', () => {
    // 2026-03-09 12:00 in New York (EDT); midnight of 03-03 was still EST (UTC-5).
    const now = Date.UTC(2026, 2, 9, 16);
    expect(resolvePeriod('7d', now, 'America/New_York').window.startMs).toBe(
      Date.UTC(2026, 2, 3, 5),
    );
  });
});

describe('labels', () => {
  it('spans local dates, with times for 24h and years for 365d', () => {
    expect(windowSpan(resolvePeriod('30d', NOW, TZ).window, '30d', TZ)).toBe('09/10 – 10/09');
    expect(windowSpan(resolvePeriod('24h', NOW, TZ).window, '24h', TZ)).toBe(
      '10/08 15:24 – 10/09 15:24',
    );
    expect(windowSpan(resolvePeriod('365d', NOW, TZ).window, '365d', TZ)).toBe(
      '2025/10/10 – 2026/10/09',
    );
  });

  it('adds the short weekday to the axis of a week of days only', () => {
    const t = (key: string): string => `[${key.split('.').at(-1)}]`;
    expect(trendLabels(t, ['2026-10-03', '2026-10-04'], 'day')).toEqual([
      '10/03 [sat]',
      '10/04 [sun]',
    ]);
    const month = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    expect(trendLabels(t, month, 'day')[0]).toBe('9/01');
    expect(trendLabels(t, ['2026-10-09T21'], 'hour')).toEqual(['21:00']);
  });

  it('labels buckets and weekdays', () => {
    expect(bucketLabel('2026-10-09T21', 'hour')).toBe('21:00');
    expect(bucketLabel('2026-09-01', 'day')).toBe('9/01');
    expect(weekdayOf('2026-10-09')).toBe(4);
    expect(localDateTime(NOW, TZ)).toBe('10/09 15:24');
  });

  it('captions the zone offset', () => {
    expect(zoneLabel(TZ, NOW)).toBe('UTC+8');
    expect(zoneLabel('UTC', NOW)).toBe('UTC');
  });

  it('measures the relative change and has none without a previous value', () => {
    expect(percentChange(12_345, 11_410)).toBeCloseTo(8.19, 2);
    expect(percentChange(4_210, 4_340)).toBeCloseTo(-3.0, 1);
    expect(percentChange(5, 0)).toBeUndefined();
  });
});
