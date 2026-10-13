import { describe, expect, it } from 'vitest';

import { meterBar, pairReading, singleReading } from '../../../../src/handlers/commands/gay/meter';
import zh from '../../../../src/i18n/locales/zh-TW/replies.json';
import en from '../../../../src/i18n/locales/en/replies.json';

const NOON = Date.UTC(2026, 9, 14, 12);
const DAY = 24 * 60 * 60_000;

describe('gay meter', () => {
  it('draws a ten-block bar', () => {
    expect(meterBar(0)).toBe('░░░░░░░░░░');
    expect(meterBar(87)).toBe('█████████░');
    expect(meterBar(100)).toBe('██████████');
  });

  it('keeps a reading fixed for the day', () => {
    expect(singleReading('u1', 'UTC', NOON)).toEqual(singleReading('u1', 'UTC', NOON + 3_600_000));
  });

  it('reads a pair the same in either order', () => {
    expect(pairReading('u1', 'u2', 'UTC', NOON)).toEqual(pairReading('u2', 'u1', 'UTC', NOON));
  });

  it('mostly reads high, and only uses comments every catalog has', () => {
    let high = 0;
    for (let day = 0; day < 400; day += 1) {
      const single = singleReading('u1', 'UTC', NOON + day * DAY);
      const pair = pairReading('u1', 'u2', 'UTC', NOON + day * DAY);
      if (single.percent >= 60) high += 1;
      for (const { percent, commentKey } of [single, pair]) {
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(100);
        const key = commentKey.split('.').at(-1) ?? '';
        expect(zh.gay).toHaveProperty(key);
        expect(en.gay).toHaveProperty(key);
      }
    }
    expect(high).toBeGreaterThan(300);
  });
});
