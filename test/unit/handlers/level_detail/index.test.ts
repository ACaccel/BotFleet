/**
 * `/level_detail` reads ranks from the cached MEE6 leaderboard: a range
 * past the end and an unreadable leaderboard each get their own answer
 * instead of an empty message or a generic failure.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMee6Leaderboard } = vi.hoisted(() => ({ fetchMee6Leaderboard: vi.fn() }));
vi.mock('../../../../src/handlers/commands/mee6-shared/leaderboard', () => ({
  fetchMee6Leaderboard: (...args: unknown[]) => fetchMee6Leaderboard(...args),
}));

import LevelDetail from '../../../../src/handlers/commands/level_detail';
import { formatLevelDetails } from '../../../../src/handlers/commands/level_detail/format';
import type { Mee6Player } from '../../../../src/handlers/commands/mee6-shared/leaderboard';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const player = (rank: number, messageCount = 10): Mee6Player => ({
  id: `id${String(rank)}`,
  rank,
  username: `user${String(rank)}`,
  discriminator: '0',
  tag: `user${String(rank)}`,
  avatarUrl: '',
  level: 5,
  messageCount,
  xp: { userXp: 1, levelXp: 2, totalXp: 100 },
});

const run = async (options: Record<string, number>) => {
  const sink = newInteractionSink();
  const { bot } = buildFakeBot();
  await new LevelDetail().execute(buildChatInputInteraction({ sink, options }), bot);
  return sink;
};

afterEach(() => fetchMee6Leaderboard.mockReset());

describe('/level_detail', () => {
  it('shows count ranks starting at rank_from', async () => {
    fetchMee6Leaderboard.mockResolvedValue([1, 2, 3, 4, 5].map((rank) => player(rank)));

    const sink = await run({ rank_from: 2, count: 2 });

    const content = String(sink.editReplies[0]?.content);
    expect(content).toContain('2 - user2');
    expect(content).toContain('3 - user3');
    expect(content).not.toContain('4 - user4');
  });

  it('defaults to ten ranks', async () => {
    fetchMee6Leaderboard.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => player(index + 1)),
    );

    const sink = await run({ rank_from: 1 });

    expect(String(sink.editReplies[0]?.content)).toContain('10 - user10');
    expect(String(sink.editReplies[0]?.content)).not.toContain('11 - user11');
  });

  it('answers out_of_range past the end of the leaderboard', async () => {
    fetchMee6Leaderboard.mockResolvedValue([player(1)]);

    const sink = await run({ rank_from: 5 });

    expect(sink.editReplies).toEqual([{ content: 'replies:level_detail.out_of_range' }]);
  });

  it('answers unavailable when MEE6 cannot be read', async () => {
    fetchMee6Leaderboard.mockRejectedValue(new Error('403'));

    const sink = await run({ rank_from: 1 });

    expect(sink.editReplies).toEqual([{ content: 'replies:level_detail.unavailable' }]);
  });
});

describe('formatLevelDetails', () => {
  it('reports zero average XP for a player without messages', () => {
    const text = formatLevelDetails([player(1, 0)], echoTranslatorWithParams());

    expect(text).toContain('"averageXp":"0"');
    expect(text).not.toContain('Infinity');
  });
});
