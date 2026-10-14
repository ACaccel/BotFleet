import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { GayReadingRepo } from '../../../../src/persistence/repositories/gay-reading.repo';
import type {
  GayArchiveSummary,
  GayStatsRepo,
} from '../../../../src/persistence/repositories/gay-stats.types';
import { archiveWindow, dailyReading } from '../../../../src/handlers/commands/gay/daily-reading';
import { pairReading, singleReading } from '../../../../src/handlers/commands/gay/meter';

const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 86_400_000;
const failure = () => err(databaseErrorFrom({ code: 50 }, { operation: 'test' }));

const fixture = (summary?: GayArchiveSummary) => {
  const snapshots = {
    find: vi.fn<GayReadingRepo['find']>(async () => ok(undefined)),
    remember: vi.fn<GayReadingRepo['remember']>(async (_key, reading) => ok(reading)),
  };
  const stats = {
    summarize: vi.fn<GayStatsRepo['summarize']>(async () => ok(summary)),
    listChannels: vi.fn<GayStatsRepo['listChannels']>(async () => ok([])),
  };
  return { userIds: ['u1'], channelIds: ['public'], timeZone: 'UTC', now: NOW, snapshots, stats };
};

describe('archive-aware daily readings', () => {
  it('uses thirty complete local dates across a daylight-saving boundary', () => {
    expect(archiveWindow(NOW, 'Asia/Taipei')).toEqual({
      startMs: Date.UTC(2026, 8, 13, 16),
      endMs: Date.UTC(2026, 9, 13, 16),
    });
    expect(archiveWindow(Date.UTC(2026, 2, 10, 12), 'America/New_York')).toEqual({
      startMs: Date.UTC(2026, 1, 8, 5),
      endMs: Date.UTC(2026, 2, 10, 4),
    });
  });

  it('reuses the stored reading without rescanning a changed archive', async () => {
    const input = fixture();
    const stored = { percent: 79, commentKey: 'replies:gay.single_high_1' };
    input.snapshots.find.mockResolvedValue(ok(stored));
    expect(await dailyReading(input)).toEqual(stored);
    expect(input.stats.summarize).not.toHaveBeenCalled();
    expect(input.snapshots.remember).not.toHaveBeenCalled();
  });

  it('freezes the base reading when the archive is missing or times out', async () => {
    const input = fixture();
    const expected = singleReading('u1', 'UTC', NOW);
    expect(await dailyReading(input)).toEqual(expected);
    expect(input.snapshots.remember).toHaveBeenCalledWith(
      expect.any(String),
      expected,
      new Date(NOW + 3 * DAY),
    );
    input.stats.summarize.mockResolvedValue(failure());
    expect(await dailyReading(input)).toEqual(expected);
  });

  it('fails closed when scope or snapshot persistence is unavailable', async () => {
    const input = fixture({
      members: [{ userId: 'u1', messages: 20, activeDays: 10, emojiRatio: 1 }],
    });
    const expected = singleReading('u1', 'UTC', NOW);
    expect(await dailyReading({ ...input, channelIds: [] })).toEqual(expected);
    expect(input.snapshots.find).not.toHaveBeenCalled();
    input.snapshots.find.mockResolvedValue(failure());
    expect(await dailyReading(input)).toEqual(expected);
    expect(input.stats.summarize).not.toHaveBeenCalled();
    input.snapshots.find.mockResolvedValue(ok(undefined));
    input.snapshots.remember.mockResolvedValue(failure());
    expect(await dailyReading(input)).toEqual(expected);
  });

  it('returns the atomic winner when concurrent queries computed different readings', async () => {
    const input = fixture();
    const winner = { percent: 41, commentKey: 'replies:gay.single_mid_2' };
    input.snapshots.remember.mockResolvedValue(ok(winner));
    expect(await dailyReading(input)).toEqual(winner);
  });

  it('separates subjects, dates, time zones and permitted scopes while sorting pairs', async () => {
    const input = fixture();
    const keyOf = async (patch: Partial<typeof input>): Promise<string> => {
      await dailyReading({ ...input, ...patch });
      return input.snapshots.find.mock.calls.at(-1)?.[0] ?? '';
    };
    const base = await keyOf({ userIds: ['u1', 'u2'], channelIds: ['b', 'a', 'a'] });
    expect(await keyOf({ userIds: ['u2', 'u1'], channelIds: ['a', 'b'] })).toBe(base);
    expect(await keyOf({ userIds: ['u1', 'u2'], channelIds: ['a'] })).not.toBe(base);
    expect(await keyOf({ userIds: ['u1', 'u2'], channelIds: ['a', 'b'], now: NOW + DAY })).not.toBe(
      base,
    );
    expect(
      await keyOf({ userIds: ['u1', 'u2'], channelIds: ['a', 'b'], timeZone: 'Asia/Taipei' }),
    ).not.toBe(base);
    expect(await keyOf({ userIds: ['u1'], channelIds: ['a', 'b'] })).not.toBe(base);
    expect(await dailyReading({ ...input, userIds: ['u1', 'u2'] })).toEqual(
      pairReading('u1', 'u2', 'UTC', NOW),
    );
    expect(input.stats.summarize).toHaveBeenLastCalledWith({
      userIds: ['u1', 'u2'],
      channelIds: ['public'],
      timeZone: 'UTC',
      window: archiveWindow(NOW, 'UTC'),
    });
  });

  it('rejects invalid subject lists', async () => {
    const input = fixture();
    await expect(dailyReading({ ...input, userIds: [] })).rejects.toThrow('one or two');
    await expect(dailyReading({ ...input, userIds: ['a', 'b', 'c'] })).rejects.toThrow(
      'one or two',
    );
  });
});
