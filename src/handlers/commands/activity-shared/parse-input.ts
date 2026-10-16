import { parseDuration } from '@core/scheduling';
import { zonedTimeToEpoch } from '../../../core/time';

const MINUTE_MS = 60_000;
/** Sign-ups last between one minute and thirty days. */
const MIN_DEADLINE_MS = MINUTE_MS;
const MAX_DEADLINE_MS = 30 * 24 * 60 * MINUTE_MS;
/** A start time may be at most a year ahead. */
const MAX_START_MS = 365 * 24 * 60 * MINUTE_MS;
const MAX_CAPACITY = 500;

const ABSOLUTE = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/;

/**
 * A start time typed as `YYYY-MM-DD HH:mm` in the bot's time zone, or as
 * a duration from now such as `2h`. `null` for anything else, a time in
 * the past, or one more than a year ahead.
 */
export const parseStartTime = (raw: string, now: number, timeZone: string): number | null => {
  const text = raw.trim();
  const match = ABSOLUTE.exec(text);
  let at: number | null;
  if (match) {
    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    at = zonedTimeToEpoch({ year, month, day, hour, minute }, timeZone);
  } else {
    const offset = parseDuration(text);
    at = offset === null ? null : now + offset;
  }
  return at !== null && at > now && at - now <= MAX_START_MS ? at : null;
};

/** The sign-up deadline from a duration such as `1d`; `null` outside 1 minute-30 days. */
export const parseDeadline = (raw: string, now: number): number | null => {
  const offset = parseDuration(raw.trim());
  return offset !== null && offset >= MIN_DEADLINE_MS && offset <= MAX_DEADLINE_MS
    ? now + offset
    : null;
};

/** An optional capacity of 1-500; `undefined` when blank, `null` when invalid. */
export const parseCapacity = (raw: string): number | null | undefined => {
  const text = raw.trim();
  if (text === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= MAX_CAPACITY ? value : null;
};
