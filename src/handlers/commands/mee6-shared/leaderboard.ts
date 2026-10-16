/**
 * Cached MEE6 leaderboard reads shared by `/level_detail` and the level
 * role sync.
 *
 * MEE6 has no public API: `mee6-levels-api` calls the undocumented
 * endpoint behind its web leaderboard, which works only while the
 * guild's leaderboard is public and temporarily bans clients that poll
 * too often. Each read fetches the top 1000 players, so one cached
 * result serves every command in the window.
 */
import Mee6LevelsApi from 'mee6-levels-api';

export type Mee6Player = Awaited<ReturnType<typeof Mee6LevelsApi.getLeaderboardPage>>[number];

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  readonly fetchedAt: number;
  readonly players: Promise<readonly Mee6Player[]>;
}

const cache = new Map<string, CacheEntry>();

/**
 * The guild's top 1000 players, best first. Concurrent callers share one
 * request; a failed request is not cached, so the next call retries.
 */
export const fetchMee6Leaderboard = async (
  guildId: string,
  now: number = Date.now(),
): Promise<readonly Mee6Player[]> => {
  const hit = cache.get(guildId);
  if (hit !== undefined && now - hit.fetchedAt < CACHE_TTL_MS) return hit.players;
  const players = Mee6LevelsApi.getLeaderboardPage(guildId);
  cache.set(guildId, { fetchedAt: now, players });
  try {
    return await players;
  } catch (error) {
    cache.delete(guildId);
    throw error;
  }
};
