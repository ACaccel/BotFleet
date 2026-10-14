/**
 * The ◀ / ▶ buttons under a `/level_detail` leaderboard: only the
 * invoker may page, each press re-reads the cached board and clamps the
 * page, and a failed read leaves the shown page in place.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type APIButtonComponentWithCustomId, type APIEmbed } from 'discord.js';

const { fetchMee6Leaderboard } = vi.hoisted(() => ({ fetchMee6Leaderboard: vi.fn() }));
vi.mock('../../../../src/handlers/commands/mee6-shared/leaderboard', () => ({
  fetchMee6Leaderboard: (...args: unknown[]) => fetchMee6Leaderboard(...args),
}));

import LevelPage from '../../../../src/handlers/buttons/level_page';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { board } from '../level_detail/fixtures';

interface SentPage {
  readonly content?: string;
  readonly embeds?: ReadonlyArray<{ toJSON: () => APIEmbed }>;
  readonly components?: ReadonlyArray<{
    toJSON: () => { components: APIButtonComponentWithCustomId[] };
  }>;
}

const press = async (customId: string, pressedBy = 'invoker') => {
  const sink = newInteractionSink();
  const { bot } = buildFakeBot({ translator: echoTranslatorWithParams() });
  const interaction = buildButtonInteraction({ customId, userId: pressedBy, sink });
  // The shared builder records follow-ups in the sink but does not expose the method.
  Object.assign(interaction, {
    followUp: async (options: { content?: string; flags?: number }) => {
      sink.followUps.push(options);
    },
  });
  await new LevelPage().execute(interaction, bot);
  return sink;
};

const pageOf = (sink: Awaited<ReturnType<typeof press>>) => {
  const sent = sink.editReplies[0] as SentPage | undefined;
  return {
    title: sent?.embeds?.[0]?.toJSON().title,
    description: sent?.embeds?.[0]?.toJSON().description ?? '',
    buttons: (sent?.components?.[0]?.toJSON().components ?? []).map((b) => [
      b.custom_id,
      b.disabled,
    ]),
  };
};

afterEach(() => fetchMee6Leaderboard.mockReset());

describe('level_page button', () => {
  it('turns to the requested page and rebinds both buttons', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(35));

    const sink = await press('level_page|invoker|2');

    expect(sink.deferUpdates).toHaveLength(1);
    const page = pageOf(sink);
    expect(page.title).toBe('replies:level_detail.page_title:{"page":2,"pages":4}');
    expect(page.description).toContain('#11 **user11**');
    expect(page.description).not.toContain('→');
    expect(page.buttons).toEqual([
      ['level_page|invoker|1', false],
      ['level_page|invoker|3', false],
    ]);
  });

  it('disables ▶ on the last page', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(35));

    const page = pageOf(await press('level_page|invoker|4'));

    expect(page.buttons).toEqual([
      ['level_page|invoker|3', false],
      ['level_page|invoker|5', true],
    ]);
  });

  it('clamps to the last page when the board shrank', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(12));

    const page = pageOf(await press('level_page|invoker|7'));

    expect(page.title).toBe('replies:level_detail.page_title:{"page":2,"pages":2}');
    expect(page.description).toContain('#12 **user12**');
  });

  it('clears the controls when the board emptied', async () => {
    fetchMee6Leaderboard.mockResolvedValue([]);

    const sink = await press('level_page|invoker|2');

    expect(sink.editReplies).toEqual([
      { content: 'replies:level_detail.empty', embeds: [], components: [] },
    ]);
  });

  it('refuses another member privately without touching the board', async () => {
    const sink = await press('level_page|invoker|2', 'stranger');

    expect(sink.replies).toEqual([
      { content: 'replies:level_detail.not_invoker', flags: MessageFlags.Ephemeral },
    ]);
    expect(sink.deferUpdates).toHaveLength(0);
    expect(sink.editReplies).toHaveLength(0);
    expect(fetchMee6Leaderboard).not.toHaveBeenCalled();
  });

  it('refuses an id this build does not write', async () => {
    const sink = await press('level_page|invoker');

    expect(sink.replies).toEqual([
      { content: 'replies:level_detail.stale', flags: MessageFlags.Ephemeral },
    ]);
    expect(fetchMee6Leaderboard).not.toHaveBeenCalled();
  });

  it('keeps the shown page and tells only the presser when MEE6 cannot be read', async () => {
    fetchMee6Leaderboard.mockRejectedValue(new Error('403'));

    const sink = await press('level_page|invoker|2');

    expect(sink.editReplies).toHaveLength(0);
    expect(sink.followUps).toEqual([
      { content: 'replies:level_detail.unavailable', flags: MessageFlags.Ephemeral },
    ]);
  });
});
