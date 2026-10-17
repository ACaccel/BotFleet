import { describe, expect, it } from 'vitest';

import { meterBar, pairReading, singleReading } from '../../../../src/handlers/commands/gay/meter';
import zh from '../../../../src/i18n/locales/zh-TW/replies.json';
import en from '../../../../src/i18n/locales/en/replies.json';
import type { GayArchiveSummary } from '../../../../src/persistence/repositories/gay-stats.types';

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

  it('reads A x B and B x A as separate pairings', () => {
    const differs = Array.from({ length: 20 }, (_, day) => {
      const now = NOON + day * DAY;
      return (
        pairReading('u1', 'u2', 'UTC', now).percent !== pairReading('u2', 'u1', 'UTC', now).percent
      );
    });
    expect(differs).toContain(true);
    expect(pairReading('u2', 'u1', 'UTC', NOON)).toEqual(
      pairReading('u2', 'u1', 'UTC', NOON + 3_600_000),
    );
  });

  it('retains the rare low branch, and only uses comments every catalog has', () => {
    let usual = 0;
    for (let day = 0; day < 400; day += 1) {
      const single = singleReading('u1', 'UTC', NOON + day * DAY);
      const pair = pairReading('u1', 'u2', 'UTC', NOON + day * DAY);
      if (single.percent >= 30) usual += 1;
      for (const { percent, commentKey } of [single, pair]) {
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(100);
        const key = commentKey.split('.').at(-1) ?? '';
        expect(zh.gay).toHaveProperty(key);
        expect(en.gay).toHaveProperty(key);
      }
    }
    expect(usual).toBeGreaterThan(360);
    expect(usual).toBeLessThan(396);
  });

  it('uses the full new usual range and the retained low branch', () => {
    const scores = Array.from(
      { length: 2000 },
      (_, day) => singleReading('u1', 'UTC', NOON + day * DAY).percent,
    );
    expect(scores).toContain(0);
    expect(scores).toContain(29);
    expect(scores).toContain(30);
    expect(scores).toContain(100);
  });

  it('uses activity and observed emoji proportions as traits, without rewarding volume', () => {
    const summary: GayArchiveSummary = {
      members: [{ userId: 'u1', messages: 12, activeDays: 3, emojiRatio: 0.5 }],
    };
    const moreMessages: GayArchiveSummary = {
      members: [{ userId: 'u1', messages: 1200, activeDays: 3, emojiRatio: 0.5 }],
    };
    expect(singleReading('u1', 'UTC', NOON, summary)).toEqual(
      singleReading('u1', 'UTC', NOON, moreMessages),
    );
    const unchanged = Array.from({ length: 20 }, (_, day) => {
      const now = NOON + day * DAY;
      return (
        singleReading('u1', 'UTC', now, summary).percent === singleReading('u1', 'UTC', now).percent
      );
    });
    expect(unchanged).toContain(false);
    expect(singleReading('u1', 'UTC', NOON, { members: [] })).toEqual(
      singleReading('u1', 'UTC', NOON),
    );
  });

  it('caps pair bonuses, applies them in either order and omits unknown elements', () => {
    const summary: GayArchiveSummary = {
      members: [],
      pair: {
        repliesABDays: 30,
        repliesBADays: 30,
        mentionsABDays: 30,
        mentionsBADays: 30,
        sharedChannelDays: 30,
      },
    };
    for (let day = 0; day < 20; day += 1) {
      const now = NOON + day * DAY;
      const base = pairReading('u1', 'u2', 'UTC', now);
      const boosted = pairReading('u1', 'u2', 'UTC', now, summary);
      expect(boosted.percent).toBe(Math.min(100, base.percent + 20));
      expect(pairReading('u2', 'u1', 'UTC', now, summary).percent).toBe(
        Math.min(100, pairReading('u2', 'u1', 'UTC', now).percent + 20),
      );
      expect(
        pairReading('u1', 'u2', 'UTC', now, { members: [], pair: { repliesABDays: 30 } }),
      ).toEqual(base);
    }
  });

  it('rewards balanced interaction more than the same number of one-sided days', () => {
    const oneSided: GayArchiveSummary = {
      members: [],
      pair: { repliesABDays: 4, repliesBADays: 0 },
    };
    const mutual: GayArchiveSummary = {
      members: [],
      pair: { repliesABDays: 2, repliesBADays: 2 },
    };
    const now = Array.from({ length: 20 }, (_, day) => NOON + day * DAY).find(
      (at) => pairReading('u1', 'u2', 'UTC', at).percent < 80,
    );
    expect(now).toBeDefined();
    expect(pairReading('u1', 'u2', 'UTC', now, mutual).percent).toBeGreaterThan(
      pairReading('u1', 'u2', 'UTC', now, oneSided).percent,
    );
  });
});
