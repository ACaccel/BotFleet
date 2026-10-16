import { describe, expect, it } from 'vitest';

import {
  assertTimeZone,
  attributeChannel,
  bucketKeyOf,
  bucketKeysOf,
  longestDayStreak,
  type ArchiveChannelInfo,
} from '../../../../src/core/archive/stats';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('attributeChannel', () => {
  const records = new Map<string, ArchiveChannelInfo>(
    [
      { channelId: 'text', type: 0, access: 'readable' },
      { channelId: 'news', type: 5, access: 'readable' },
      { channelId: 'forum', type: 15, access: 'readable' },
      { channelId: 'media', type: 16, access: 'readable' },
      { channelId: 'text-thread', type: 11, parentId: 'text', access: 'readable' },
      { channelId: 'news-thread', type: 10, parentId: 'news', access: 'readable' },
      { channelId: 'private-thread', type: 12, parentId: 'text', access: 'readable' },
      { channelId: 'forum-post', type: 11, parentId: 'forum', access: 'readable' },
      { channelId: 'media-post', type: 11, parentId: 'media', access: 'deleted' },
      { channelId: 'orphan-thread', type: 11, parentId: 'unknown', access: 'readable' },
      { channelId: 'parentless-thread', type: 11, access: 'readable' },
    ].map((record) => [record.channelId, record as ArchiveChannelInfo]),
  );
  const attribute = (channelId: string) => attributeChannel(channelId, (id) => records.get(id));

  it('folds text and announcement threads into their channel', () => {
    expect(attribute('text-thread')).toEqual({ channelId: 'text' });
    expect(attribute('news-thread')).toEqual({ channelId: 'news' });
    expect(attribute('private-thread')).toEqual({ channelId: 'text' });
  });

  it('keeps forum and media posts standalone with their forum', () => {
    expect(attribute('forum-post')).toEqual({ channelId: 'forum-post', forumId: 'forum' });
    expect(attribute('media-post')).toEqual({ channelId: 'media-post', forumId: 'media' });
  });

  it('counts channels, unknown channels and parentless threads as themselves', () => {
    expect(attribute('text')).toEqual({ channelId: 'text' });
    expect(attribute('missing')).toEqual({ channelId: 'missing' });
    expect(attribute('parentless-thread')).toEqual({ channelId: 'parentless-thread' });
    // An unrecorded parent is assumed to be a text channel, the common case.
    expect(attribute('orphan-thread')).toEqual({ channelId: 'unknown' });
  });
});

describe('bucket keys', () => {
  // 2026-01-04 (Sunday) 20:30 UTC = 2026-01-05 (Monday) 04:30 in Taipei.
  const at = Date.UTC(2026, 0, 4, 20, 30);

  it('formats local hour, day and Monday-week keys', () => {
    expect(bucketKeyOf(at, 'hour', 'UTC')).toBe('2026-01-04T20');
    expect(bucketKeyOf(at, 'hour', 'Asia/Taipei')).toBe('2026-01-05T04');
    expect(bucketKeyOf(at, 'day', 'UTC')).toBe('2026-01-04');
    expect(bucketKeyOf(at, 'day', 'Asia/Taipei')).toBe('2026-01-05');
    expect(bucketKeyOf(at, 'week', 'UTC')).toBe('2025-12-29');
    expect(bucketKeyOf(at, 'week', 'Asia/Taipei')).toBe('2026-01-05');
  });

  it('lists every touched bucket without gaps, partial ends included', () => {
    const window = { startMs: Date.UTC(2026, 0, 1, 12), endMs: Date.UTC(2026, 0, 4, 12) };
    expect(bucketKeysOf(window, 'day', 'UTC')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(bucketKeysOf(window, 'week', 'UTC')).toEqual(['2025-12-29']);
    expect(bucketKeysOf({ startMs: at, endMs: at + 3 * HOUR }, 'hour', 'UTC')).toEqual([
      '2026-01-04T20',
      '2026-01-04T21',
      '2026-01-04T22',
      '2026-01-04T23',
    ]);
    expect(bucketKeysOf({ startMs: at, endMs: at }, 'day', 'UTC')).toEqual([]);
  });

  it('keeps hourly buckets continuous across a DST change', () => {
    // 2026-03-08 02:00 local does not exist in New York.
    const start = Date.UTC(2026, 2, 8, 5);
    const keys = bucketKeysOf(
      { startMs: start, endMs: start + 4 * HOUR },
      'hour',
      'America/New_York',
    );
    expect(keys).toEqual(['2026-03-08T00', '2026-03-08T01', '2026-03-08T03', '2026-03-08T04']);
    expect(
      bucketKeysOf({ startMs: start, endMs: start + 2 * DAY }, 'day', 'America/New_York'),
    ).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('rejects an unknown time zone', () => {
    expect(() => assertTimeZone('Not/AZone')).toThrow(RangeError);
    expect(() => assertTimeZone('Asia/Taipei')).not.toThrow();
  });
});

describe('longestDayStreak', () => {
  it('finds the longest consecutive run across month boundaries', () => {
    expect(longestDayStreak([])).toBe(0);
    expect(longestDayStreak(['2026-01-05'])).toBe(1);
    expect(
      longestDayStreak(['2026-02-01', '2026-01-30', '2026-01-31', '2026-01-28', '2026-01-31']),
    ).toBe(3);
  });
});
