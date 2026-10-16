/**
 * Regression test for `scheduleGiveaway` channel resolution.
 *
 * After the giveaway redesign the announcement is published in the
 * channel `/giveaway create` was invoked from, so the persisted
 * `channel_id` may be a thread or a channel that is not in
 * `guild.channels.cache` after a restart. The reboot/end path must
 * fall back to an API fetch so the winner draw is not stranded; if even
 * the fetch cannot resolve a sendable channel it must fail cleanly.
 */
import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../src/core/result';
import { scheduleGiveaway } from '../../../src/application/giveaway/giveaway';
import type { GiveawayDeps } from '../../../src/application/giveaway/giveaway';
import { echoTranslator } from '../../fixtures/runtime';

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'thread-99';
const MESSAGE_ID = 'msg-1';

const makeGiveawayDoc = () => ({
  channel_id: CHANNEL_ID,
  winner_num: 1,
  prize: 'A Prize',
  prize_owner_id: 'owner-1',
  message_id: MESSAGE_ID,
  end_time: 0,
  participants: [],
});

const makeRepos = () => ({
  giveaway: {
    findByMessageId: vi.fn().mockResolvedValue(ok(makeGiveawayDoc())),
    deleteByMessageId: vi.fn().mockResolvedValue(ok(true)),
  },
});

// A sendable channel whose '🎉' reaction is absent, so the winner draw
// resolves to the no-participants branch without further mocking.
const makeChannel = () => ({
  isSendable: () => true,
  messages: {
    fetch: vi.fn().mockResolvedValue({ reactions: { cache: { get: () => undefined } } }),
  },
  send: vi.fn().mockResolvedValue(undefined),
});

const makeDeps = (
  repos: ReturnType<typeof makeRepos>,
  channelsFetch: ReturnType<typeof vi.fn>,
): GiveawayDeps =>
  ({
    client: {
      // `guild.channels.cache.get` deliberately misses so the fetch
      // fallback is exercised.
      guilds: {
        cache: new Map([
          [
            GUILD_ID,
            { channels: { cache: { get: () => undefined } }, members: { cache: new Map() } },
          ],
        ]),
      },
      channels: { fetch: channelsFetch },
    },
    registry: {
      getRepos: () => repos,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: new Map(),
    logger: { error: vi.fn() },
    translator: echoTranslator(),
  }) as unknown as GiveawayDeps;

describe('scheduleGiveaway channel resolution (thread / uncached channel)', () => {
  it('falls back to client.channels.fetch when the channel is not cached', async () => {
    const repos = makeRepos();
    const channel = makeChannel();
    const channelsFetch = vi.fn().mockResolvedValue(channel);

    const result = await scheduleGiveaway(makeDeps(repos, channelsFetch), GUILD_ID, MESSAGE_ID);

    expect(channelsFetch).toHaveBeenCalledWith(CHANNEL_ID);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(repos.giveaway.deleteByMessageId).toHaveBeenCalledWith(MESSAGE_ID);
    expect(result).toEqual({ status: 'completed' });
  });

  it('fails cleanly when neither cache nor fetch resolves the channel', async () => {
    const repos = makeRepos();
    const channelsFetch = vi.fn().mockRejectedValue(new Error('unknown channel'));

    const result = await scheduleGiveaway(makeDeps(repos, channelsFetch), GUILD_ID, MESSAGE_ID);

    expect(result).toEqual({ status: 'channel_not_found' });
    expect(repos.giveaway.deleteByMessageId).not.toHaveBeenCalled();
  });
});
