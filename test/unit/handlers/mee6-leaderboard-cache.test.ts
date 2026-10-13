/** One MEE6 read per guild per five minutes, shared by concurrent callers. */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

const { getLeaderboardPage } = vi.hoisted(() => ({ getLeaderboardPage: vi.fn() }));
vi.mock('mee6-levels-api', () => ({ default: { getLeaderboardPage } }));

import { fetchMee6Leaderboard } from '../../../src/handlers/commands/mee6-shared/leaderboard';

describe('fetchMee6Leaderboard', () => {
  it('reuses a read for five minutes, then fetches again', async () => {
    getLeaderboardPage.mockResolvedValue([{ rank: 1 }]);

    await Promise.all([fetchMee6Leaderboard('g-cache', 0), fetchMee6Leaderboard('g-cache', 1)]);
    await fetchMee6Leaderboard('g-cache', 299_999);
    expect(getLeaderboardPage).toHaveBeenCalledTimes(1);

    await fetchMee6Leaderboard('g-cache', 300_000);
    expect(getLeaderboardPage).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    getLeaderboardPage.mockReset();
    getLeaderboardPage.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce([]);

    await expect(fetchMee6Leaderboard('g-fail', 0)).rejects.toThrow('403');
    await expect(fetchMee6Leaderboard('g-fail', 1)).resolves.toEqual([]);
  });
});
