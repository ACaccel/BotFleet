import { createHash } from 'node:crypto';

/** `YYYY-MM-DD` of `now` in `timeZone`, so "today" follows the bot's configured zone. */
const dayKey = (now: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(now);

/**
 * A number in `[0, 2^32)` fixed for `seed` for the rest of the day, so
 * asking again today gives the same answer instead of a re-roll.
 */
export const dailyRoll = (seed: string, timeZone: string, now: number = Date.now()): number =>
  createHash('sha256')
    .update(`${seed}|${dayKey(now, timeZone)}`)
    .digest()
    .readUInt32BE(0);

/** An independent roll for a second decision on the same seed. */
export const secondRoll = (seed: string, timeZone: string, now?: number): number =>
  dailyRoll(`${seed}#2`, timeZone, now);
