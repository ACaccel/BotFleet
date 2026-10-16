/** Pure `/level_detail` formatting: bars, paging, entries and card fields. */
import { describe, expect, it } from 'vitest';

import { bindTranslator } from '../../../../src/core/i18n';
import {
  clampPage,
  formatCardFields,
  formatLeaderboardPage,
  formatNumber,
  pageCount,
  pageOfRank,
  progressBar,
  rankBadge,
} from '../../../../src/handlers/commands/level_detail/format';
import { echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { board, player } from './fixtures';

const t = bindTranslator(echoTranslatorWithParams());

describe('progressBar', () => {
  it('is empty at 0% and full at 100%', () => {
    expect(progressBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱ 0%');
    expect(progressBar(1)).toBe('▰▰▰▰▰▰▰▰▰▰ 100%');
  });

  it('rounds down so a nearly finished level is not shown as complete', () => {
    expect(progressBar(0.999)).toBe('▰▰▰▰▰▰▰▰▰▱ 99%');
    expect(progressBar(0.63)).toBe('▰▰▰▰▰▰▱▱▱▱ 63%');
  });

  it('clamps ratios outside [0, 1]', () => {
    expect(progressBar(-0.5)).toBe('▱▱▱▱▱▱▱▱▱▱ 0%');
    expect(progressBar(3)).toBe('▰▰▰▰▰▰▰▰▰▰ 100%');
  });
});

describe('paging', () => {
  it('counts at least one page, ten players each', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageCount(1000)).toBe(100);
  });

  it('clamps pages into range', () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(9, 3)).toBe(3);
  });

  it('maps a rank to its page', () => {
    expect(pageOfRank(1)).toBe(1);
    expect(pageOfRank(10)).toBe(1);
    expect(pageOfRank(11)).toBe(2);
    expect(pageOfRank(1000)).toBe(100);
  });
});

describe('formatNumber and rankBadge', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('gives medals to the top three and #rank below', () => {
    expect([1, 2, 3, 4].map(rankBadge)).toEqual(['🥇', '🥈', '🥉', '#4']);
  });
});

describe('formatLeaderboardPage', () => {
  it('shows ten entries of the requested page', () => {
    const { page, pages, description } = formatLeaderboardPage(board(25), 2, t);

    expect({ page, pages }).toEqual({ page: 2, pages: 3 });
    expect(description).toContain('#11 **user11**');
    expect(description).toContain('#20 **user20**');
    expect(description).not.toContain('user21');
    expect(description).not.toContain('**user10**');
  });

  it('clamps a page past the end of a shrunk board', () => {
    const { page, pages, description } = formatLeaderboardPage(board(5), 4, t);

    expect({ page, pages }).toEqual({ page: 1, pages: 1 });
    expect(description).toContain('🥇 **user1**');
  });

  it('formats an entry with level, bar, messages and average XP', () => {
    const players = [
      player(1, { messageCount: 1234, xp: { userXp: 1, levelXp: 4, totalXp: 4936 } }),
    ];
    const { description } = formatLeaderboardPage(players, 1, t);

    expect(description).toBe(
      '🥇 **user1** · replies:level_detail.entry_level:{"level":5}\n' +
        '▰▰▱▱▱▱▱▱▱▱ 25% · replies:level_detail.entry_messages:{"messages":"1,234"}' +
        ' · replies:level_detail.entry_average:{"average":"4"}',
    );
  });

  it('omits the average for a player without messages', () => {
    const { description } = formatLeaderboardPage([player(1, { messageCount: 0 })], 1, t);

    expect(description).not.toContain('entry_average');
    expect(description).not.toContain('Infinity');
  });

  it('marks only the highlighted rank', () => {
    const { description } = formatLeaderboardPage(board(10), 1, t, 4);

    expect(description).toContain('→ #4 **__user4__**');
    expect(description.match(/→/gu)).toHaveLength(1);
  });

  it('escapes markdown in usernames', () => {
    const { description } = formatLeaderboardPage([player(1, { username: '*bold*' })], 1, t);

    expect(description).toContain('**\\*bold\\***');
  });
});

describe('formatCardFields', () => {
  const values = (fields: ReturnType<typeof formatCardFields>) =>
    Object.fromEntries(fields.map((field) => [field.name, field.value]));

  it('reports progress, averages, the estimate and the gap to the rank above', () => {
    const players = [
      player(1, { xp: { userXp: 0, levelXp: 100, totalXp: 20_000 } }),
      player(2, { messageCount: 1000, xp: { userXp: 1500, levelXp: 2000, totalXp: 12_500 } }),
    ];

    const fields = values(formatCardFields(players, 1, t));

    expect(fields['replies:level_detail.card_rank']).toBe('🥈 #2');
    expect(fields['replies:level_detail.card_total_xp']).toBe('12,500');
    expect(fields['replies:level_detail.card_progress:{"level":6}']).toBe(
      '▰▰▰▰▰▰▰▱▱▱ 75%\nreplies:level_detail.card_xp_value:{"userXp":"1,500","levelXp":"2,000"}',
    );
    expect(fields['replies:level_detail.card_messages']).toBe('1,000');
    expect(fields['replies:level_detail.card_average']).toBe('12.5');
    // 500 XP left at 12.5 XP per message.
    expect(fields['replies:level_detail.card_estimate']).toBe(
      'replies:level_detail.card_estimate_value:{"messages":"40"}',
    );
    expect(fields['replies:level_detail.card_gap:{"rank":1}']).toBe(
      'replies:level_detail.card_gap_value:{"xp":"7,500"}',
    );
  });

  it('omits the gap for rank 1 and the estimate without messages', () => {
    const fields = formatCardFields([player(1, { messageCount: 0 })], 0, t);
    const names = fields.map((field) => field.name);

    expect(names.some((name) => name.includes('card_gap'))).toBe(false);
    expect(names).not.toContain('replies:level_detail.card_estimate');
    expect(values(fields)['replies:level_detail.card_average']).toBe('—');
    expect(values(fields)['replies:level_detail.card_rank']).toBe('🥇 #1');
  });

  it('shows a plain #rank below the medals', () => {
    expect(values(formatCardFields(board(5), 4, t))['replies:level_detail.card_rank']).toBe('#5');
  });
});
