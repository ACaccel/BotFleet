/**
 * Unit coverage for member names known only by ID: the member cache wins, a
 * lookup that fails leaves the fallback, lookups skip the client cache, and the
 * whole batch gives up after its deadline instead of holding the reply.
 */
import type { Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cachedBotIds,
  resolveUserNames,
} from '../../../../src/handlers/commands/traffic-shared/names';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const botMember = (id: string, displayName: string) => {
  const member = buildGuildMember({ id, displayName });
  Object.assign(member.user, { bot: true });
  return member;
};

const guildWith = (fetch: (id: string, options: unknown) => Promise<unknown>): Guild =>
  Object.assign(
    buildGuild({
      members: [buildGuildMember({ id: 'm1', displayName: 'Cached' }), botMember('b1', 'Bot')],
    }),
    {
      client: {
        users: {
          fetch,
          cache: new Map([
            ['b2', { bot: true }],
            ['u9', { bot: false }],
          ]),
        },
      },
    },
  );

afterEach(() => vi.useRealTimers());

describe('resolveUserNames', () => {
  it('prefers the member cache and falls back when a lookup fails', async () => {
    const fetch = vi.fn(async (id: string) => {
      if (id === 'gone') throw new Error('Unknown User');
      return { username: 'user', globalName: id === 'g' ? 'Global' : null };
    });
    const names = await resolveUserNames(guildWith(fetch), ['m1', 'g', 'plain', 'gone'], '?');
    expect(Object.fromEntries(names)).toEqual({
      m1: 'Cached',
      g: 'Global',
      plain: 'user',
      gone: '?',
    });
    expect(fetch).toHaveBeenCalledWith('g', { cache: false });
    expect(fetch).not.toHaveBeenCalledWith('m1', expect.anything());
  });

  it('gives up on slow lookups after the deadline', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise(() => undefined));
    const pending = resolveUserNames(guildWith(fetch), ['slow'], '?');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Object.fromEntries(await pending)).toEqual({ slow: '?' });
  });
});

describe('cachedBotIds', () => {
  it('collects bots from the member cache and the client user cache', () => {
    expect(cachedBotIds(guildWith(async () => ({}))).sort()).toEqual(['b1', 'b2']);
  });
});
