import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_MAX_GUILD_BREAKS,
  ARCHIVE_RESCAN_SAFETY_MS,
  addContinuityBreak,
  beginArchiveContinuity,
  continuityFullChannelIds,
  continuityRescanFrom,
  settleContinuityBreaks,
} from '../../../../src/core/archive/continuity';
import type { ArchiveGatewayContinuity } from '../../../../src/core/archive/types';

const previous: ArchiveGatewayContinuity = {
  bootId: 'old',
  continuousSince: 100,
  confirmedAt: 500,
  fullRequired: false,
  gapVersion: 4,
  breakIndex: 2,
  breaks: [{ index: 2, start: 300, channelId: '10' }],
};

describe('archive Gateway continuity at boot', () => {
  it('requires a full reconciliation when no earlier continuity was recorded', () => {
    expect(beginArchiveContinuity(null, 'boot', 1000)).toEqual({
      bootId: 'boot',
      continuousSince: 1000,
      confirmedAt: 1000,
      fullRequired: true,
      gapVersion: 0,
      breakIndex: 0,
      breaks: [],
    });
  });

  it('starts a guild-wide break at the previous confirmation and carries the rest', () => {
    expect(beginArchiveContinuity({ ...previous, fullRequired: true }, 'boot', 1000)).toEqual({
      bootId: 'boot',
      continuousSince: 1000,
      confirmedAt: 1000,
      fullRequired: true,
      gapVersion: 4,
      breakIndex: 3,
      breaks: [
        { index: 2, start: 300, channelId: '10' },
        { index: 3, start: 500, channelId: null },
      ],
    });
  });

  it.each([
    { run: undefined, gapVersion: 4, fullRequired: false },
    { run: 3, gapVersion: 4, fullRequired: false },
    { run: 4, gapVersion: 4, fullRequired: false },
    // A gap counted after the run began was lost before it became durable.
    { run: 6, gapVersion: 7, fullRequired: true },
  ])(
    'moves past a run gap version of $run the record never saw',
    ({ run, gapVersion, fullRequired }) => {
      expect(beginArchiveContinuity(previous, 'boot', 1000, run)).toMatchObject({
        gapVersion,
        fullRequired,
      });
    },
  );

  it('moves past a run gap version even without a record', () => {
    expect(beginArchiveContinuity(null, 'boot', 1000, 2)).toMatchObject({
      gapVersion: 3,
      fullRequired: true,
    });
  });
});

describe('archive continuity breaks', () => {
  it('settles breaks up to the index a run was created after', () => {
    const breaks = [
      { index: 1, start: 100, channelId: null },
      { index: 2, start: 200, channelId: '10' },
      { index: 3, start: 300, channelId: null },
    ];
    expect(settleContinuityBreaks(breaks, 0)).toEqual(breaks);
    expect(settleContinuityBreaks(breaks, 2)).toEqual([breaks[2]]);
    expect(settleContinuityBreaks(breaks, 3)).toEqual([]);
    // Frequent breaks still settle: the bound moves to the earliest later break.
    expect(continuityRescanFrom(settleContinuityBreaks(breaks, 1))).toBe(
      300 - ARCHIVE_RESCAN_SAFETY_MS,
    );
  });

  it('derives the rescan bound from guild-wide breaks and full sources from channel breaks', () => {
    const breaks = [
      { index: 1, start: 900_000, channelId: '10' },
      { index: 2, start: 500_000, channelId: null },
      { index: 3, start: 700_000, channelId: null },
    ];
    expect(continuityRescanFrom(breaks)).toBe(500_000 - ARCHIVE_RESCAN_SAFETY_MS);
    expect(continuityRescanFrom([breaks[0]!])).toBeUndefined();
    expect(continuityFullChannelIds(breaks)).toEqual(['10']);
  });

  it('merges a channel break with its pending predecessor conservatively', () => {
    expect(
      addContinuityBreak(
        [
          { index: 1, start: 100, channelId: '10' },
          { index: 2, start: 200, channelId: null },
        ],
        { index: 3, start: 300, channelId: '10' },
      ),
    ).toEqual([
      { index: 2, start: 200, channelId: null },
      { index: 3, start: 100, channelId: '10' },
    ]);
  });

  it('merges the oldest guild-wide breaks beyond the cap without shrinking coverage', () => {
    let breaks = addContinuityBreak([], { index: 1, start: 50, channelId: '10' });
    for (let index = 2; index <= ARCHIVE_MAX_GUILD_BREAKS + 2; index += 1)
      breaks = addContinuityBreak(breaks, { index, start: index * 100, channelId: null });
    const guildWide = breaks.filter((entry) => entry.channelId === null);
    expect(guildWide).toHaveLength(ARCHIVE_MAX_GUILD_BREAKS);
    expect(guildWide[0]).toEqual({ index: 3, start: 200, channelId: null });
    expect(breaks).toContainEqual({ index: 1, start: 50, channelId: '10' });
    expect(continuityRescanFrom(breaks)).toBe(200 - ARCHIVE_RESCAN_SAFETY_MS);
  });
});
