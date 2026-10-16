/**
 * Pure rules shared by the archive statistics reader and the `/traffic` commands:
 * which messages count, how threads attribute to channels, and the local-time
 * bucket keys that trends, heat maps and active-day streaks use. No persistence and
 * no Discord types, so both layers apply one definition.
 */
import type { ArchiveChannel } from './types';

/** Message types counted as member activity: default (0) and reply (19). */
export const MEMBER_MESSAGE_TYPES = [0, 19] as const;
/** Discord message type of a reply. */
export const REPLY_MESSAGE_TYPE = 19;
/** `reference.type` of a forwarded message. */
export const FORWARD_REFERENCE_TYPE = 1;
/** Message flag of a voice message (`IS_VOICE_MESSAGE`, 1 << 13). */
export const VOICE_MESSAGE_FLAG = 8192;
/** Announcement, public and private thread channel types. */
export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);
export const PRIVATE_THREAD_CHANNEL_TYPE = 12;
/** Forum and media channels: their posts are threads that stand alone in rankings. */
const FORUM_CHANNEL_TYPES: ReadonlySet<number> = new Set([15, 16]);
export const CATEGORY_CHANNEL_TYPE = 4;
/** Interaction types of `interactionMetadata.type`. */
export const INTERACTION_TYPES = { command: 2, component: 3, modal: 5 } as const;

/** The `archive_channels` fields readers use; checkpoints and discovery stay with the writer. */
export type ArchiveChannelInfo = Pick<
  ArchiveChannel,
  'channelId' | 'name' | 'type' | 'parentId' | 'access' | 'everyoneCanView'
>;

/** A half-open `[startMs, endMs)` range of message creation times. */
export interface StatsWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/** Trend bucket size. Keys are local to the requested time zone. */
export type StatsGranularity = 'hour' | 'day' | 'week';

/** The row a message's channel counts under in a channel ranking. */
export interface ChannelAttribution {
  /** The channel itself, or the parent of a thread under a text or announcement channel. */
  readonly channelId: string;
  /** Set for a forum or media post: the forum or media channel it belongs to. */
  readonly forumId?: string;
}

/**
 * Threads under a text or announcement channel count toward that channel; a forum
 * or media post stands alone because it is its own topic. A thread whose parent is
 * unknown also folds into its recorded parent, the common case; a channel without
 * a record counts as itself.
 */
export const attributeChannel = (
  channelId: string,
  lookup: (channelId: string) => ArchiveChannelInfo | undefined,
): ChannelAttribution => {
  const record = lookup(channelId);
  if (record?.type === undefined || !THREAD_CHANNEL_TYPES.has(record.type)) return { channelId };
  const parentId = record.parentId;
  if (parentId === undefined) return { channelId };
  const parentType = lookup(parentId)?.type;
  if (parentType !== undefined && FORUM_CHANNEL_TYPES.has(parentType))
    return { channelId, forumId: parentId };
  return { channelId: parentId };
};

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * Throws `RangeError` for a time zone the runtime does not know. MongoDB accepts
 * the same IANA names, so a zone valid here is valid in the aggregation.
 */
export const assertTimeZone = (timeZone: string): void => {
  formatterFor(timeZone);
};

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
}
const localParts = (timestampMs: number, timeZone: string): LocalParts => {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(timestampMs))
    parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
  };
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Days since the Unix epoch of a calendar date; calendar arithmetic needs no time zone. */
const epochDay = (year: number, month: number, day: number): number =>
  Date.UTC(year, month - 1, day) / DAY_MS;
const dateKeyOfEpochDay = (value: number): string => {
  const date = new Date(value * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};
/** Monday of the ISO week containing the epoch day. */
const mondayOf = (value: number): number =>
  value - ((new Date(value * DAY_MS).getUTCDay() + 6) % 7);

/** Where a timestamp falls in local time. */
export interface LocalSlot {
  /** `YYYY-MM-DDTHH`. */
  readonly hourKey: string;
  /** `YYYY-MM-DD`. */
  readonly dayKey: string;
  /** `YYYY-MM-DD` of the Monday that starts the week. */
  readonly weekKey: string;
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number;
  /** 0–23. */
  readonly hour: number;
}

export const localSlotOf = (timestampMs: number, timeZone: string): LocalSlot => {
  const parts = localParts(timestampMs, timeZone);
  const day = epochDay(parts.year, parts.month, parts.day);
  const dayKey = dateKeyOfEpochDay(day);
  return {
    hourKey: `${dayKey}T${pad(parts.hour)}`,
    dayKey,
    weekKey: dateKeyOfEpochDay(mondayOf(day)),
    weekday: (new Date(day * DAY_MS).getUTCDay() + 6) % 7,
    hour: parts.hour,
  };
};

/**
 * The trend bucket key of a timestamp: `YYYY-MM-DDTHH` (hour), `YYYY-MM-DD` (day), or
 * the `YYYY-MM-DD` of the local Monday that starts the week.
 */
export const bucketKeyOf = (
  timestampMs: number,
  granularity: StatsGranularity,
  timeZone: string,
): string => {
  const slot = localSlotOf(timestampMs, timeZone);
  switch (granularity) {
    case 'hour':
      return slot.hourKey;
    case 'day':
      return slot.dayKey;
    case 'week':
      return slot.weekKey;
    default: {
      const unreachable: never = granularity;
      throw new TypeError(`Unknown granularity ${String(unreachable)}`);
    }
  }
};

/**
 * Every bucket key the window touches, oldest first, so a trend has no gaps. The
 * first and last buckets can be partial when the window does not start or end on
 * a bucket boundary.
 */
export const bucketKeysOf = (
  window: StatsWindow,
  granularity: StatsGranularity,
  timeZone: string,
): string[] => {
  if (window.endMs <= window.startMs) return [];
  const keys: string[] = [];
  if (granularity === 'hour') {
    // Absolute hours: a DST change repeats or skips a local hour, never a bucket.
    for (let at = window.startMs; at < window.endMs; at += HOUR_MS) {
      const key = bucketKeyOf(at, 'hour', timeZone);
      if (keys.at(-1) !== key) keys.push(key);
    }
    const last = bucketKeyOf(window.endMs - 1, 'hour', timeZone);
    if (keys.at(-1) !== last) keys.push(last);
    return keys;
  }
  const first = localParts(window.startMs, timeZone);
  const last = localParts(window.endMs - 1, timeZone);
  let day = epochDay(first.year, first.month, first.day);
  let end = epochDay(last.year, last.month, last.day);
  const step = granularity === 'week' ? 7 : 1;
  if (granularity === 'week') {
    day = mondayOf(day);
    end = mondayOf(end);
  }
  for (; day <= end; day += step) keys.push(dateKeyOfEpochDay(day));
  return keys;
};

/** Longest run of consecutive calendar days among `YYYY-MM-DD` keys. */
export const longestDayStreak = (dayKeys: readonly string[]): number => {
  const days = [
    ...new Set(
      dayKeys.map((key) => {
        const [year, month, day] = key.split('-').map(Number);
        return epochDay(year ?? 0, month ?? 1, day ?? 1);
      }),
    ),
  ].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | undefined;
  for (const day of days) {
    run = previous !== undefined && day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return longest;
};
