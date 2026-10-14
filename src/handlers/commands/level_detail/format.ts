/**
 * Pure formatting for `/level_detail`: paging math, progress bars, the
 * leaderboard page text and the personal card fields. Discord builders
 * live in `view.ts`, so everything here is plain strings and numbers.
 */
import { escapeMarkdown } from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import type { Mee6Player } from '../mee6-shared/leaderboard';

/** Players per leaderboard page; ten two-line entries stay far below the embed limit. */
const PAGE_SIZE = 10;

const BAR_LENGTH = 10;
const MEDALS = ['🥇', '🥈', '🥉'] as const;

/** Whole numbers with thousands separators. */
export const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-US');

const formatAverage = (value: number): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Average XP per message, or `undefined` for a player without counted messages. */
const averageXp = (player: Mee6Player): number | undefined =>
  player.messageCount > 0 ? player.xp.totalXp / player.messageCount : undefined;

/** Share of the current level already earned, clamped to `[0, 1]`. */
const levelRatio = (player: Mee6Player): number =>
  player.xp.levelXp > 0 ? Math.min(1, Math.max(0, player.xp.userXp / player.xp.levelXp)) : 0;

/**
 * A ten-segment bar plus percentage. Both round down, so a full bar and
 * 100% appear only once the level is actually complete.
 */
export const progressBar = (ratio: number): string => {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.floor(clamped * BAR_LENGTH);
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_LENGTH - filled)} ${Math.floor(clamped * 100)}%`;
};

/** Medal for the top three, `#rank` for everyone else. */
export const rankBadge = (rank: number): string => MEDALS[rank - 1] ?? `#${rank}`;

export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));

/** Keeps a requested page inside `[1, pages]`, e.g. after the leaderboard shrank. */
export const clampPage = (page: number, pages: number): number =>
  Math.min(pages, Math.max(1, Math.trunc(page)));

export const pageOfRank = (rank: number): number => Math.ceil(rank / PAGE_SIZE);

const formatEntry = (player: Mee6Player, t: BoundTranslate, highlighted: boolean): string => {
  const name = escapeMarkdown(player.username);
  const average = averageXp(player);
  const marker = highlighted ? '→ ' : '';
  const shownName = highlighted ? `__${name}__` : name;
  const level = t('replies:level_detail.entry_level', { level: player.level });
  const stats = [
    progressBar(levelRatio(player)),
    t('replies:level_detail.entry_messages', { messages: formatNumber(player.messageCount) }),
    ...(average === undefined
      ? []
      : [t('replies:level_detail.entry_average', { average: formatAverage(average) })]),
  ];
  return `${marker}${rankBadge(player.rank)} **${shownName}** · ${level}\n${stats.join(' · ')}`;
};

interface LeaderboardPageText {
  /** The page actually shown, after clamping. */
  readonly page: number;
  readonly pages: number;
  readonly description: string;
}

/** One leaderboard page; `highlightRank` marks the entry a `rank:` jump asked for. */
export const formatLeaderboardPage = (
  players: readonly Mee6Player[],
  requestedPage: number,
  t: BoundTranslate,
  highlightRank?: number,
): LeaderboardPageText => {
  const pages = pageCount(players.length);
  const page = clampPage(requestedPage, pages);
  const description = players
    .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    .map((player) => formatEntry(player, t, player.rank === highlightRank))
    .join('\n');
  return { page, pages, description };
};

interface CardField {
  readonly name: string;
  readonly value: string;
  readonly inline: boolean;
}

/**
 * The personal card's fields for `players[index]`. The estimate needs a
 * non-zero average and the gap needs someone ranked above, so each is
 * omitted when it would be meaningless.
 */
export const formatCardFields = (
  players: readonly Mee6Player[],
  index: number,
  t: BoundTranslate,
): CardField[] => {
  const player = players[index];
  if (player === undefined) return [];
  const above = players[index - 1];
  const average = averageXp(player);
  const remaining = Math.max(0, player.xp.levelXp - player.xp.userXp);
  const key = (name: string): string => `replies:level_detail.card_${name}`;
  const field = (name: string, value: string, inline = true): CardField => ({
    name,
    value,
    inline,
  });
  const fields: CardField[] = [
    field(t(key('rank')), `${rankBadge(player.rank)}${player.rank <= 3 ? ` #${player.rank}` : ''}`),
    field(t(key('level')), formatNumber(player.level)),
    field(t(key('total_xp')), formatNumber(player.xp.totalXp)),
    field(
      t(key('progress'), { level: player.level + 1 }),
      `${progressBar(levelRatio(player))}\n${t(key('xp_value'), {
        userXp: formatNumber(player.xp.userXp),
        levelXp: formatNumber(player.xp.levelXp),
      })}`,
      false,
    ),
    field(t(key('messages')), formatNumber(player.messageCount)),
    field(t(key('average')), average === undefined ? '—' : formatAverage(average)),
  ];
  if (average !== undefined) {
    const messages = formatNumber(Math.ceil(remaining / average));
    fields.push(field(t(key('estimate')), t(key('estimate_value'), { messages })));
  }
  if (above !== undefined) {
    const xp = formatNumber(Math.max(0, above.xp.totalXp - player.xp.totalXp));
    fields.push(field(t(key('gap'), { rank: above.rank }), t(key('gap_value'), { xp })));
  }
  return fields;
};
