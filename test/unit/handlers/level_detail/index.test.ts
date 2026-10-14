/**
 * `/level_detail` reads the cached MEE6 leaderboard: no options shows
 * page one, `rank` jumps to its page, `member` shows a card, and an
 * unreadable board or a rank past the end each get their own answer.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIEmbed, APIButtonComponentWithCustomId } from 'discord.js';

const { fetchMee6Leaderboard } = vi.hoisted(() => ({ fetchMee6Leaderboard: vi.fn() }));
vi.mock('../../../../src/handlers/commands/mee6-shared/leaderboard', () => ({
  fetchMee6Leaderboard: (...args: unknown[]) => fetchMee6Leaderboard(...args),
}));

import LevelDetail from '../../../../src/handlers/commands/level_detail';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { board } from './fixtures';

interface MemberOption {
  readonly id: string;
  /** A cached guild member; omitted, the option resolves to a user only. */
  readonly member?: { displayName: string; displayAvatarURL: () => string };
}

interface SentReply {
  readonly content?: string;
  readonly embeds?: ReadonlyArray<{ toJSON: () => APIEmbed }>;
  readonly components?: ReadonlyArray<{
    toJSON: () => { components: APIButtonComponentWithCustomId[] };
  }>;
  readonly allowedMentions?: unknown;
}

const run = async (options: { rank?: number; member?: MemberOption } = {}) => {
  const sink = newInteractionSink();
  const { bot } = buildFakeBot({ translator: echoTranslatorWithParams() });
  const interaction = buildChatInputInteraction({
    sink,
    userId: 'invoker',
    options: options.rank === undefined ? {} : { rank: options.rank },
  });
  const member = options.member;
  // The shared builder has no user-option resolvers; add the two this command reads.
  Object.assign(interaction.options, {
    getUser: (name: string) =>
      name === 'member' && member
        ? {
            id: member.id,
            displayName: 'global',
            displayAvatarURL: () => 'https://cdn.example/user.png',
          }
        : null,
    getMember: (name: string) =>
      name === 'member' && member ? (member.member ?? { user: { id: member.id } }) : null,
  });
  await new LevelDetail().execute(interaction, bot);
  return sink.editReplies[0] as SentReply;
};

const embedOf = (reply: SentReply): APIEmbed => {
  const embed = reply.embeds?.[0]?.toJSON();
  if (embed === undefined) throw new Error(`no embed: ${String(reply.content)}`);
  return embed;
};

const buttonsOf = (reply: SentReply) => reply.components?.[0]?.toJSON().components ?? [];

afterEach(() => fetchMee6Leaderboard.mockReset());

describe('/level_detail leaderboard', () => {
  it('shows page one with ◀ disabled and the invoker bound to the buttons', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(25));

    const reply = await run();

    const embed = embedOf(reply);
    expect(embed.title).toBe('replies:level_detail.page_title:{"page":1,"pages":3}');
    expect(embed.description).toContain('🥇 **user1**');
    expect(embed.description).toContain('#10 **user10**');
    expect(embed.description).not.toContain('user11');
    expect(embed.footer?.text).toBe('replies:level_detail.footer:{"total":"25"}');
    expect(buttonsOf(reply).map((b) => [b.custom_id, b.disabled])).toEqual([
      ['level_page|invoker|0', true],
      ['level_page|invoker|2', false],
    ]);
    expect(reply.allowedMentions).toEqual({ parse: [] });
  });

  it('opens the page holding the rank and marks it', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(25));

    const reply = await run({ rank: 23 });

    const embed = embedOf(reply);
    expect(embed.title).toBe('replies:level_detail.page_title:{"page":3,"pages":3}');
    expect(embed.description).toContain('→ #23 **__user23__**');
    expect(buttonsOf(reply).map((b) => b.disabled)).toEqual([false, true]);
  });

  it('answers out_of_range past the end of the leaderboard', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(1));

    const reply = await run({ rank: 5 });

    expect(reply.content).toBe('replies:level_detail.out_of_range:{"total":1}');
  });

  it('answers empty when nobody is ranked', async () => {
    fetchMee6Leaderboard.mockResolvedValue([]);

    expect((await run()).content).toBe('replies:level_detail.empty');
  });

  it('answers unavailable when MEE6 cannot be read', async () => {
    fetchMee6Leaderboard.mockRejectedValue(new Error('403'));

    expect((await run()).content).toBe('replies:level_detail.unavailable');
  });

  it('answers failed with a trace id on an unexpected error', async () => {
    // A malformed board throws after the read succeeded.
    fetchMee6Leaderboard.mockResolvedValue(null);

    expect((await run()).content).toMatch(/^replies:level_detail\.failed:\{"traceId":"\w+"\}$/u);
  });
});

describe('/level_detail member', () => {
  it('shows the card with the server avatar, ignoring rank', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(25));

    const reply = await run({
      rank: 1,
      member: {
        id: 'id7',
        member: { displayName: 'Seven', displayAvatarURL: () => 'https://cdn.example/server.png' },
      },
    });

    const embed = embedOf(reply);
    expect(embed.title).toBe('replies:level_detail.card_title:{"name":"Seven"}');
    expect(embed.thumbnail?.url).toBe('https://cdn.example/server.png');
    expect(embed.fields?.find((f) => f.name === 'replies:level_detail.card_rank')?.value).toBe(
      '#7',
    );
    expect(reply.components).toBeUndefined();
    expect(reply.allowedMentions).toEqual({ parse: [] });
  });

  it('falls back to the user profile for an uncached member', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(3));

    const embed = embedOf(await run({ member: { id: 'id2' } }));

    expect(embed.title).toBe('replies:level_detail.card_title:{"name":"global"}');
    expect(embed.thumbnail?.url).toBe('https://cdn.example/user.png');
  });

  it('answers not_ranked without pinging the member', async () => {
    fetchMee6Leaderboard.mockResolvedValue(board(3));

    const reply = await run({ member: { id: 'absent' } });

    expect(reply.content).toBe('replies:level_detail.not_ranked:{"member":"<@absent>"}');
    expect(reply.allowedMentions).toEqual({ parse: [] });
  });
});
