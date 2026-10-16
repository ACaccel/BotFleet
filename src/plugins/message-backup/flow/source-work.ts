import { snowflakeTimestamp } from '../../../core/archive/normalize';

/**
 * Estimated full-scan work per source, in Discord requests: a history page returns
 * up to 100 messages, while every reaction list takes at least one request of its
 * own. A channel's requests of one route run one after another in
 * `@discordjs/rest`, so requests approximate a source's scan time.
 */
const MESSAGES_PER_PAGE = 100;
/**
 * Messages a day assumed for a source known only by its span: a deliberately low
 * prior, so a known count usually outranks a span of similar size.
 */
const SPAN_MESSAGES_PER_DAY = 24;
const DAY_MS = 86_400_000;
/** Discord stopped counting thread messages at 50 for threads created before this date. */
const THREAD_COUNT_COMPLETE_FROM = Date.UTC(2022, 6, 1);
const LEGACY_THREAD_COUNT_LIMIT = 50;

/**
 * Where an estimate came from, cheapest evidence first: the stored archive, a
 * thread's message count, the span between a source's creation and its last
 * message, or nothing.
 */
export type SourceWorkBasis = 'stored' | 'thread-count' | 'span' | 'unknown';

/** A source this run already started: its backward cursor and the messages it scanned. */
export interface SourceResume {
  readonly before: string;
  readonly scanned: number;
}

/** What discovery and the source's checkpoints say about one source. */
export interface SourceWorkHint {
  readonly id: string;
  /** Discord's `message_count` of a thread. */
  readonly threadMessageCount?: number;
  /** Discord's `last_message_id`. */
  readonly lastMessageId?: string;
  readonly resume?: SourceResume;
  /** A completed full scan stored the source's whole history, so stored counts are complete. */
  readonly storedComplete?: true;
}

/** A source's stored history before the scan's bounds (see `ArchiveRepo.storedSourceWork`). */
export interface StoredWork {
  readonly messages: number;
  /** Absent when the stored estimate could not sum reaction lists. */
  readonly reactionLists?: number;
}

/** Estimated requests of one source; a source without an estimate counts none. */
export type SourceWorkEstimate = { readonly id: string } & (
  | { readonly basis: 'unknown'; readonly work: 0 }
  | { readonly basis: Exclude<SourceWorkBasis, 'unknown'>; readonly work: number }
);

export const isSnowflake = (value: string | undefined): value is string =>
  value !== undefined && /^\d{1,20}$/.test(value);

const requests = (messages: number, reactionLists: number): number =>
  messages / MESSAGES_PER_PAGE + reactionLists;

/** Stored reaction lists per stored message, the weight heuristics give unseen reactions. */
export const storedReactionRatio = (stored: ReadonlyMap<string, StoredWork>): number => {
  let messages = 0;
  let reactionLists = 0;
  for (const work of stored.values()) {
    if (work.reactionLists === undefined) continue;
    messages += work.messages;
    reactionLists += work.reactionLists;
  }
  return messages === 0 ? 0 : reactionLists / messages;
};

/** Messages a source has yet to scan, from discovery alone. */
const heuristicMessages = (
  hint: SourceWorkHint,
  cutoff: number,
):
  | { readonly basis: Extract<SourceWorkBasis, 'thread-count' | 'span'>; readonly messages: number }
  | undefined => {
  if (!isSnowflake(hint.id)) return undefined;
  const created = snowflakeTimestamp(hint.id);
  const ends = [cutoff];
  if (isSnowflake(hint.lastMessageId)) ends.push(snowflakeTimestamp(hint.lastMessageId));
  if (hint.resume !== undefined && isSnowflake(hint.resume.before))
    ends.push(snowflakeTimestamp(hint.resume.before));
  const span = (Math.max(0, Math.min(...ends) - created) / DAY_MS) * SPAN_MESSAGES_PER_DAY;
  const count = hint.threadMessageCount;
  if (count !== undefined && Number.isFinite(count) && count >= 0) {
    const remaining = Math.max(0, count - (hint.resume?.scanned ?? 0));
    const truncated = created < THREAD_COUNT_COMPLETE_FROM && count >= LEGACY_THREAD_COUNT_LIMIT;
    return { basis: 'thread-count', messages: truncated ? Math.max(remaining, span) : remaining };
  }
  return isSnowflake(hint.lastMessageId) ? { basis: 'span', messages: span } : undefined;
};

/**
 * A source's estimated work. Stored counts are exact once a completed full scan
 * stored the source's history; before that they are a floor, and a larger
 * discovery estimate wins. Sources without stored history fall back to a thread's
 * message count, then to the span from creation to the last message.
 */
export const estimateSourceWork = (
  hint: SourceWorkHint,
  stored: StoredWork | undefined,
  cutoff: number,
  reactionRatio = 0,
): SourceWorkEstimate => {
  const heuristic = heuristicMessages(hint, cutoff);
  const heuristicWork =
    heuristic === undefined
      ? undefined
      : requests(heuristic.messages, heuristic.messages * reactionRatio);
  if (stored !== undefined) {
    const work = requests(stored.messages, stored.reactionLists ?? 0);
    if (hint.storedComplete === true || heuristicWork === undefined || work >= heuristicWork)
      return { id: hint.id, basis: 'stored', work };
  }
  return heuristic === undefined || heuristicWork === undefined
    ? { id: hint.id, basis: 'unknown', work: 0 }
    : { id: hint.id, basis: heuristic.basis, work: heuristicWork };
};

const compareIds = (left: string, right: string): number =>
  left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);

/**
 * Sources ordered largest first (longest-processing-time first), so the largest
 * start while other readers take the rest; unknown sources go last, and equal
 * estimates keep the older channel ID first.
 */
export const orderSourcesByWork = (
  hints: readonly SourceWorkHint[],
  stored: ReadonlyMap<string, StoredWork>,
  cutoff: number,
): SourceWorkEstimate[] => {
  const ratio = storedReactionRatio(stored);
  return hints
    .map((hint) => estimateSourceWork(hint, stored.get(hint.id), cutoff, ratio))
    .sort(
      (left, right) =>
        Number(left.basis === 'unknown') - Number(right.basis === 'unknown') ||
        right.work - left.work ||
        compareIds(left.id, right.id),
    );
};
