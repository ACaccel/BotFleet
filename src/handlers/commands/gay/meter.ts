import { dailyRoll, secondRoll } from '../fun-shared/daily-roll';
import type { GayArchiveSummary } from '../../../persistence/repositories/gay-stats.types';

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
 * Archive traits alter the daily seed, never award points for message volume.
 * Usually 30-100, with 0-29 one time in twenty. Fixed for the day.
 */
export const singleReading = (
  userId: string,
  timeZone: string,
  now?: number,
  summary?: GayArchiveSummary,
): Reading => {
  const member = summary?.members.find((entry) => entry.userId === userId);
  const traits =
    member === undefined || member.messages === 0
      ? ''
      : `|days:${member.activeDays}${member.emojiRatio === undefined ? '' : `|emoji:${Math.round(member.emojiRatio * 100)}`}`;
  const seed = `gay|${userId}${traits}`;
  const roll = dailyRoll(seed, timeZone, now);
  const extra = secondRoll(seed, timeZone, now);
  const percent = roll % 20 === 0 ? extra % 30 : 30 + (extra % 71);
  return reading('single', percent, roll);
};

/** Today's pair reading, the same whichever order the two members are given. */
export const pairReading = (
  a: string,
  b: string,
  timeZone: string,
  now?: number,
  summary?: GayArchiveSummary,
): Reading => {
  const seed = `gay-pair|${[a, b].sort().join('|')}`;
  const pair = summary?.pair;
  // Bidirectional days earn more than one-sided attention, capped per element.
  const mutualPoints = (forward?: number, backward?: number): number =>
    forward === undefined || backward === undefined
      ? 0
      : Math.min(10, Math.min(forward, backward) * 2 + Math.min(2, Math.max(forward, backward)));
  const bonus =
    pair === undefined
      ? 0
      : Math.min(
          20,
          mutualPoints(pair.repliesABDays, pair.repliesBADays) +
            Math.min(5, mutualPoints(pair.mentionsABDays, pair.mentionsBADays)) +
            Math.min(5, pair.sharedChannelDays ?? 0),
        );
  return reading(
    'pair',
    Math.min(100, (dailyRoll(seed, timeZone, now) % 101) + bonus),
    secondRoll(seed, timeZone, now),
  );
};
