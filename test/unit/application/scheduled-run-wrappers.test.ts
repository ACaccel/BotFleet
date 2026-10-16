/**
 * The deferred-job wrapper around `scheduleGiveaway`.
 *
 * A job callback has no user to answer, so before these wrappers a
 * missing channel or a deleted announcement was indistinguishable from
 * a completed draw: the outcome was simply discarded. Their whole job
 * is to put a non-success outcome on the operator channel.
 */
import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../src/core/result';
import { runGiveawayDraw } from '../../../src/application/giveaway/giveaway';
import type { GiveawayDeps } from '../../../src/application/giveaway/giveaway';
import { echoTranslator } from '../../fixtures/runtime';

const GUILD_ID = 'g1';

/**
 * Deps whose repo lookup succeeds or not. `hasRepos: false` drives the
 * `no_db` outcome, which is the simplest non-completed variant to reach
 * without a full Discord fake.
 */
const buildDeps = (hasRepos: boolean, warn: ReturnType<typeof vi.fn>) =>
  ({
    client: {
      guilds: {
        cache: new Map([
          [
            GUILD_ID,
            {
              channels: { cache: { get: () => sendableChannel() } },
              members: { cache: new Map() },
            },
          ],
        ]),
      },
      channels: { fetch: vi.fn(async () => sendableChannel()) },
    },
    registry: {
      getRepos: () => (hasRepos ? repos() : undefined),
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [GUILD_ID],
    },
    jobMap: new Map(),
    logger: { warn, error: vi.fn(), info: vi.fn() },
    translator: echoTranslator(),
  }) as unknown as GiveawayDeps;

const sendableChannel = () => ({
  isSendable: () => true,
  messages: {
    fetch: vi.fn().mockResolvedValue({ reactions: { cache: { get: () => undefined } } }),
  },
  send: vi.fn().mockResolvedValue(undefined),
});

const repos = () => ({
  giveaway: {
    findByMessageId: vi.fn().mockResolvedValue(
      ok({
        channel_id: 'c1',
        message_id: 'm1',
        prize: 'A Prize',
        prize_owner_id: 'o1',
        winner_num: 1,
        end_time: 0,
        participants: [],
      }),
    ),
    deleteByMessageId: vi.fn().mockResolvedValue(ok(true)),
  },
});

describe('runGiveawayDraw', () => {
  it('stays quiet when the draw completes', async () => {
    const warn = vi.fn();
    await runGiveawayDraw(buildDeps(true, warn), GUILD_ID, 'm1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the outcome when the draw cannot complete', async () => {
    const warn = vi.fn();
    await runGiveawayDraw(buildDeps(false, warn), GUILD_ID, 'm1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as [{ outcome: string }])[0].outcome).toBe('no_db');
  });
});
