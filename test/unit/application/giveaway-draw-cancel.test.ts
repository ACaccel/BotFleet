/**
 * Giveaway draws pick distinct winners from every entrant, not just the
 * first 100 reactors in the member cache, and cancelling checks who asks
 * and marks the announcement so members stop entering.
 */
import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../src/core/result';
import {
  deleteGiveaway,
  drawWinners,
  scheduleGiveaway,
  type GiveawayDeps,
} from '../../../src/application/giveaway/giveaway';
import { echoTranslator } from '../../fixtures/runtime';

const GUILD_ID = 'guild-1';
const MESSAGE_ID = 'msg-1';

const record = { channel_id: 'chan-1', winner_num: 2, prize: 'Prize', prize_owner_id: 'owner' };

const usersPage = (ids: readonly string[]) => {
  const page = new Map(ids.map((id) => [id, { id, bot: id.startsWith('bot') }]));
  return Object.assign(page, { lastKey: () => ids[ids.length - 1] });
};

const build = (entrantIds: readonly string[], cachedIds: readonly string[]) => {
  const members = new Map(cachedIds.map((id) => [id, { id }]));
  const membersFetch = vi.fn(async ({ user }: { user: string[] }) => {
    for (const id of user) members.set(id, { id });
  });
  const pages = [entrantIds.slice(0, 100), entrantIds.slice(100)];
  const usersFetch = vi.fn(async () => usersPage(pages.shift() ?? []));
  const edit = vi.fn(async () => undefined);
  const removeAll = vi.fn(async () => undefined);
  const message = {
    reactions: { cache: { get: () => ({ users: { fetch: usersFetch } }) }, removeAll },
    embeds: [{ title: 'Prize', data: {} }],
    edit,
  };
  const channel = {
    isSendable: () => true,
    messages: { fetch: vi.fn(async () => message) },
    send: vi.fn(async (_options: unknown) => undefined),
  };
  const repos = {
    giveaway: {
      findByMessageId: vi.fn(async () => ok(record)),
      deleteByMessageId: vi.fn(async () => ok(true)),
    },
  };
  const guild = {
    id: GUILD_ID,
    channels: { cache: new Map([['chan-1', channel]]) },
    members: { cache: members, fetch: membersFetch },
  };
  const deps = {
    client: { guilds: { cache: new Map([[GUILD_ID, guild]]) }, channels: { fetch: vi.fn() } },
    registry: { getRepos: () => repos, getChannel: () => undefined, listGuildIds: () => [] },
    jobMap: new Map(),
    logger: { warn: vi.fn(), error: vi.fn() },
    translator: echoTranslator(),
  } as unknown as GiveawayDeps;
  return { deps, channel, repos, usersFetch, membersFetch, edit };
};

describe('drawWinners', () => {
  it('picks distinct entrants, at most the requested count', () => {
    for (let i = 0; i < 50; i += 1) {
      const winners = drawWinners(['a', 'b', 'c', 'd'], 3);
      expect(new Set(winners).size).toBe(3);
    }
    expect(drawWinners(['a'], 5)).toEqual(['a']);
  });

  it('gives every entrant a chance to win', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(drawWinners(['a', 'b', 'c'], 1)[0] as string);
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('scheduleGiveaway entrants', () => {
  it('reads every reaction page and fetches members missing from the cache', async () => {
    const entrants = Array.from({ length: 150 }, (_, i) => `u${String(i)}`);
    const { deps, channel, usersFetch, membersFetch } = build(entrants, ['u0']);

    await scheduleGiveaway(deps, GUILD_ID, MESSAGE_ID);

    expect(usersFetch).toHaveBeenCalledTimes(2);
    expect(membersFetch).toHaveBeenCalled();
    const sent = channel.send.mock.calls[0]?.[0] as { allowedMentions: { users: string[] } };
    expect(sent.allowedMentions.users).toHaveLength(3);
    expect(sent.allowedMentions.users).toContain('owner');
  });
});

describe('deleteGiveaway', () => {
  it('refuses a requester the authority check rejects', async () => {
    const { deps, repos } = build([], []);

    const outcome = await deleteGiveaway(deps, GUILD_ID, MESSAGE_ID, () => false);

    expect(outcome).toEqual({ status: 'forbidden' });
    expect(repos.giveaway.deleteByMessageId).not.toHaveBeenCalled();
  });

  it('reports a giveaway that no longer exists', async () => {
    const { deps, repos } = build([], []);
    repos.giveaway.findByMessageId.mockResolvedValueOnce(ok(null as never));

    expect(await deleteGiveaway(deps, GUILD_ID, MESSAGE_ID)).toEqual({
      status: 'giveaway_not_found',
    });
  });

  it('removes the record and marks the announcement cancelled', async () => {
    const { deps, repos, edit } = build([], []);

    const outcome = await deleteGiveaway(deps, GUILD_ID, MESSAGE_ID, (owner) => owner === 'owner');

    expect(outcome).toEqual({ status: 'deleted' });
    expect(repos.giveaway.deleteByMessageId).toHaveBeenCalledWith(MESSAGE_ID);
    expect(edit).toHaveBeenCalledOnce();
  });
});
