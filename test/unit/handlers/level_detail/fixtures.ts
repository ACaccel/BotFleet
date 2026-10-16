import type { Mee6Player } from '../../../../src/handlers/commands/mee6-shared/leaderboard';

/** A MEE6 player at `rank`; totals fall with rank so the board stays ordered. */
export const player = (rank: number, overrides: Partial<Mee6Player> = {}): Mee6Player => ({
  id: `id${rank}`,
  rank,
  username: `user${rank}`,
  discriminator: '0',
  tag: `user${rank}`,
  avatarUrl: `https://cdn.discordapp.com/avatars/id${rank}/hash`,
  level: 5,
  messageCount: 100,
  xp: { userXp: 50, levelXp: 200, totalXp: 100_000 - rank * 100 },
  ...overrides,
});

export const board = (size: number): Mee6Player[] =>
  Array.from({ length: size }, (_, index) => player(index + 1));
