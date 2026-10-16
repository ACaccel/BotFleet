/**
 * Unit tests for {@link fetchAllUserGuilds}.
 *
 * `Routes.userGuilds()` caps at 200 results per page, so a bot in more
 * than 200 guilds is only fully pruned if the fetch pages through them.
 * These pin the `after` cursor pagination and its termination
 * conditions.
 */
import type { REST } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchAllUserGuilds,
  GUILD_PAGE_LIMIT,
  type PartialUserGuild,
} from '../../src/register-guilds';

const makeGuilds = (count: number, startId: number): PartialUserGuild[] =>
  Array.from({ length: count }, (_, i) => ({ id: String(startId + i), name: `g${startId + i}` }));

const restWithPages = (
  pages: PartialUserGuild[][],
): { rest: REST; get: ReturnType<typeof vi.fn> } => {
  const get = vi.fn();
  for (const page of pages) get.mockResolvedValueOnce(page);
  return { rest: { get } as unknown as REST, get };
};

describe('fetchAllUserGuilds', () => {
  it('returns a single short page without a second request', async () => {
    const { rest, get } = restWithPages([makeGuilds(3, 1)]);
    const out = await fetchAllUserGuilds(rest);
    expect(out).toHaveLength(3);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('follows the after cursor across full pages until a short page', async () => {
    const page1 = makeGuilds(GUILD_PAGE_LIMIT, 1);
    const page2 = makeGuilds(GUILD_PAGE_LIMIT, 10_000);
    const page3 = makeGuilds(7, 20_000);
    const { rest, get } = restWithPages([page1, page2, page3]);

    const out = await fetchAllUserGuilds(rest);

    expect(out).toHaveLength(GUILD_PAGE_LIMIT * 2 + 7);
    expect(get).toHaveBeenCalledTimes(3);
    // First call has no cursor; later calls carry after = last id of the prior page.
    expect((get.mock.calls[0]?.[1] as { query: URLSearchParams }).query.get('after')).toBeNull();
    expect((get.mock.calls[1]?.[1] as { query: URLSearchParams }).query.get('after')).toBe(
      page1[page1.length - 1]?.id,
    );
    expect((get.mock.calls[2]?.[1] as { query: URLSearchParams }).query.get('after')).toBe(
      page2[page2.length - 1]?.id,
    );
  });

  it('terminates when a full page is followed by an empty page', async () => {
    const { rest, get } = restWithPages([makeGuilds(GUILD_PAGE_LIMIT, 1), []]);
    const out = await fetchAllUserGuilds(rest);
    expect(out).toHaveLength(GUILD_PAGE_LIMIT);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('always requests the page limit', async () => {
    const { rest, get } = restWithPages([makeGuilds(1, 1)]);
    await fetchAllUserGuilds(rest);
    expect((get.mock.calls[0]?.[1] as { query: URLSearchParams }).query.get('limit')).toBe(
      String(GUILD_PAGE_LIMIT),
    );
  });
});
