import { dailyRoll, secondRoll } from '../fun-shared/daily-roll';

const BAR_LENGTH = 10;

/** `████████░░` for 0-100. */
export const meterBar = (percent: number): string => {
  const filled = Math.round((percent / 100) * BAR_LENGTH);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_LENGTH - filled)}`;
};

/** Comment tier for a percentage: `low` (<40), `mid` (<75), `high`. */
const tierOf = (percent: number): 'low' | 'mid' | 'high' =>
  percent < 40 ? 'low' : percent < 75 ? 'mid' : 'high';

export interface Reading {
  readonly percent: number;
  readonly commentKey: string;
}

/** Comment lines per tier in the `gay` catalog. */
const LINES_PER_TIER = 2;

const reading = (kind: 'single' | 'pair', percent: number, extra: number): Reading => ({
  percent,
  commentKey: `replies:gay.${kind}_${tierOf(percent)}_${String((extra % LINES_PER_TIER) + 1)}`,
});

/**
 * Today's reading for one member: usually 60-100, keeping the joke the
 * command always had, and 0-39 one time in twenty. Fixed for the day.
 */
export const singleReading = (userId: string, timeZone: string, now?: number): Reading => {
  const roll = dailyRoll(`gay|${userId}`, timeZone, now);
  const extra = secondRoll(`gay|${userId}`, timeZone, now);
  const percent = roll % 20 === 0 ? extra % 40 : 60 + (extra % 41);
  return reading('single', percent, roll);
};

/** Today's pair reading, the same whichever order the two members are given. */
export const pairReading = (a: string, b: string, timeZone: string, now?: number): Reading => {
  const seed = `gay-pair|${[a, b].sort().join('|')}`;
  return reading('pair', dailyRoll(seed, timeZone, now) % 101, secondRoll(seed, timeZone, now));
};
