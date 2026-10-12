import { reactionKey } from '../../../core/archive/normalize';
import type { ArchiveInboxEntry, ArchiveMessage } from '../../../core/archive/types';

/** Which reaction lists a refresh rereads. */
export type ReactionRefreshScope =
  | { readonly kind: 'all' }
  /** Only the message itself: its counts and fields, no membership lists. */
  | { readonly kind: 'none' }
  /**
   * The lists of these reactions, of one type when `type` is set, answering the
   * live change that marked the lists stale at `staleMark`.
   */
  | {
      readonly kind: 'some';
      readonly keys: readonly string[];
      readonly type?: 0 | 1;
      readonly staleMark: number;
    };
export const ALL_REACTIONS: ReactionRefreshScope = { kind: 'all' };
export interface ReactionRefreshOptions {
  /** The snapshot write or the live event already marked the lists stale. */
  readonly staleMarked?: boolean;
  readonly scope?: ReactionRefreshScope;
  /**
   * Reports membership progress to the history source that owns the refresh, which
   * clears its activity when the source ends. Live and inbox refreshes own no
   * source activity and report nothing.
   */
  readonly onActivity?: (counts: ReactionActivityCounts) => void;
}
/** Membership staged so far by one refresh. */
interface ReactionActivityCounts {
  readonly reactionUsers: number;
  readonly reactionPages: number;
}
/** A raw reaction with its identity (see `reactionKey`). */
export interface RawReaction {
  readonly key: string;
  readonly emoji: { readonly id?: string; readonly name?: string };
  readonly count?: number;
  readonly count_details?: { readonly normal: number; readonly burst: number };
}
/** The identifiable reactions of a raw message; one without an emoji ID or name is skipped. */
export const rawReactions = (raw: Record<string, unknown>): RawReaction[] =>
  (Array.isArray(raw.reactions) ? (raw.reactions as Omit<RawReaction, 'key'>[]) : []).flatMap(
    (reaction) => {
      const key = reactionKey(reaction.emoji);
      return key === undefined ? [] : [{ ...reaction, key }];
    },
  );
/**
 * Whether a raw message reports the same reactions and counts as a stored one,
 * ignoring the reactions in `except`.
 */
export const sameReactionCounts = (
  raw: Record<string, unknown>,
  stored: ArchiveMessage,
  except: ReadonlySet<string> = new Set(),
): boolean => {
  const fresh = new Map(
    rawReactions(raw)
      .filter((reaction) => !except.has(reaction.key))
      .map((reaction) => [
        reaction.key,
        `${reaction.count}|${reaction.count_details?.normal}|${reaction.count_details?.burst}`,
      ]),
  );
  const previous = new Map(
    (stored.reactions ?? []).flatMap((reaction) => {
      const key = reactionKey(reaction.emoji);
      return key === undefined || except.has(key)
        ? []
        : [
            [
              key,
              `${reaction.count}|${reaction.countDetails?.normal}|${reaction.countDetails?.burst}`,
            ] as const,
          ];
    }),
  );
  return (
    fresh.size === previous.size && [...fresh].every(([key, value]) => previous.get(key) === value)
  );
};
/** Whether a raw message reports no reactions. */
export const noReactions = (raw: Record<string, unknown>): boolean =>
  raw.reactions === undefined || (Array.isArray(raw.reactions) && raw.reactions.length === 0);
const NO_REACTIONS: ReactionRefreshScope = { kind: 'none' };
/**
 * The reaction lists a live event's reconciliation rereads (C5). Lists never
 * completely refreshed, refreshed before the current lossless capture window, or
 * already marked stale by an earlier change still to be answered, are reread whole. Otherwise an edit or poll vote changes no list, and
 * a reaction event names the one it changed; an event that does not say rereads all.
 */
export const liveRefreshScope = (
  entry: Extract<ArchiveInboxEntry, { kind: 'snapshot' | 'reaction' }>,
  prior: ArchiveMessage | null,
  continuousSince: number,
): ReactionRefreshScope => {
  // Lists refreshed before the current lossless capture window may have missed changes.
  if (
    prior === null ||
    prior.reactionsFreshAt === undefined ||
    prior.reactionsFreshAt < continuousSince ||
    prior.reactionsStaleAt !== undefined
  )
    return ALL_REACTIONS;
  if (entry.kind === 'snapshot') return NO_REACTIONS;
  const target = entry.payload.target;
  if (target === undefined || target.scope === 'all') return ALL_REACTIONS;
  if (target.scope === 'poll') return NO_REACTIONS;
  return {
    kind: 'some',
    keys: [target.emojiKey],
    ...(target.type === undefined ? {} : { type: target.type }),
    staleMark: entry.observedAt,
  };
};
