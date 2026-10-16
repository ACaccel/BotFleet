import { dailyRoll, secondRoll } from '../fun-shared/daily-roll';

/** Comment tiers and how many lines each has in the `give_score` catalog. */
const TIERS = [
  { tier: 'negative', min: -1, max: -1, lines: 2 },
  { tier: 'low', min: 0, max: 3, lines: 3 },
  { tier: 'mid', min: 4, max: 6, lines: 3 },
  { tier: 'high', min: 7, max: 9, lines: 3 },
  { tier: 'perfect', min: 10, max: 10, lines: 2 },
  { tier: 'bonus', min: 11, max: 11, lines: 2 },
] as const;

export interface Score {
  readonly score: number;
  /** Catalog key of the comment, such as `replies:give_score.comment.high_2`. */
  readonly commentKey: string;
}

/**
 * Today's score for `subject`: 0-10, except one roll in a hundred lands
 * on 11 or -1. The same subject gets the same score and comment all day.
 */
export const scoreFor = (subject: string, timeZone: string, now?: number): Score => {
  const roll = dailyRoll(`give_score|${subject.toLowerCase()}`, timeZone, now);
  const extra = secondRoll(`give_score|${subject.toLowerCase()}`, timeZone, now);
  const score = roll % 100 === 0 ? (extra % 2 === 0 ? 11 : -1) : roll % 11;
  const tier = TIERS.find((entry) => score >= entry.min && score <= entry.max) ?? TIERS[1];
  return {
    score,
    commentKey: `replies:give_score.comment.${tier.tier}_${String((extra % tier.lines) + 1)}`,
  };
};
