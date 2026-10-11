/**
 * Privacy filter for `/traffic`: the channels whose archived messages a reply may
 * count. The result feeds every member statistic as `channelId: { $in: [...] }`;
 * `/traffic emoji` and `/traffic sticker` deliberately skip it.
 *
 * Candidates are the `archive_channels` records plus the live guild cache, so
 * archived threads and deleted channels are judged instead of silently dropped.
 * A channel counts only when every gate passes:
 *   (a) operator rank — its effective rank (own rank and every ancestor, resolved
 *       through the cache or the recorded parents) is at most the ceiling:
 *         - `ephemeral` → the invoker's rank (only they see the reply);
 *         - `public`    → `min(invoker rank, command channel rank)`;
 *   (b) Discord access for the INVOKER (never the counted member):
 *         - a live channel needs View Channel;
 *         - a thread (live or archived) is judged through its parent: View Channel
 *           on the parent, plus Manage Threads for a private thread, because
 *           members of a private thread cannot be verified without an API call per
 *           thread; a recorded thread of unknown type is treated as private;
 *         - a channel missing from the cache counts only when its record says it
 *           was deleted and `@everyone` could view it; a thread whose parent is gone
 *           follows the parent's record, and a private one never counts;
 *   (c) `public` only — audience coverage: every role (`@everyone` included) that
 *       can view the command channel can also view the channel, judged through the
 *       parent for a thread, so a public reply never shows the command channel
 *       activity its readers cannot see. Private threads never count in public.
 *
 * {@link resolveVisibleChannelIds} is pure; `allowed-channels.ts` adapts a
 * discord.js guild and member to it.
 */
import {
  CATEGORY_CHANNEL_TYPE,
  PRIVATE_THREAD_CHANNEL_TYPE,
  THREAD_CHANNEL_TYPES,
  type ArchiveChannelInfo,
} from '../../../core/archive/stats';

import type { Visibility } from './types';

/** One cached channel as the invoking member sees it. */
export interface LiveChannelAccess {
  readonly type: number;
  readonly parentId: string | null;
  readonly canView: boolean;
  readonly canManageThreads: boolean;
  /**
   * Every role that can view the command channel can view this one. Only read for a
   * `public` reply; `false` when the command channel's audience is unknown.
   */
  readonly audienceCanView: boolean;
}

export interface VisibleChannelInput {
  /** `archive_channels` records, deleted channels included. */
  readonly records: readonly ArchiveChannelInfo[];
  /** The guild channel cache, keyed by channel ID. */
  readonly live: ReadonlyMap<string, LiveChannelAccess>;
  readonly mode: Visibility;
  readonly userRank: number;
  readonly commandChannelId: string;
  /** Effective rank of a channel given its ancestor chain (`PermissionRankPolicy.channelRank`). */
  readonly channelRank: (channelId: string, ancestorIds: readonly string[]) => number;
}

/** Discord nests at most category > channel > thread; the cap guards against a cycle. */
const MAX_ANCESTOR_DEPTH = 8;

export const resolveVisibleChannelIds = (input: VisibleChannelInput): ReadonlySet<string> => {
  const { live } = input;
  const records = new Map(input.records.map((record) => [record.channelId, record]));
  const parentOf = (channelId: string): string | undefined => {
    const cached = live.get(channelId);
    return cached === undefined ? records.get(channelId)?.parentId : (cached.parentId ?? undefined);
  };
  const ancestorsOf = (channelId: string): string[] => {
    const ancestors: string[] = [];
    let parentId = parentOf(channelId);
    while (parentId !== undefined && ancestors.length < MAX_ANCESTOR_DEPTH) {
      ancestors.push(parentId);
      parentId = parentOf(parentId);
    }
    return ancestors;
  };
  const rankOf = (channelId: string): number =>
    input.channelRank(channelId, ancestorsOf(channelId));
  const ceiling =
    input.mode === 'public'
      ? Math.min(input.userRank, rankOf(input.commandChannelId))
      : input.userRank;

  const isPublic = input.mode === 'public';
  const typeOf = (channelId: string): number | undefined =>
    live.get(channelId)?.type ?? records.get(channelId)?.type;
  /** A recorded child of something other than a category, type unknown: maybe a thread. */
  const unknownThread = (channelId: string): boolean => {
    const parentId = parentOf(channelId);
    return (
      typeOf(channelId) === undefined &&
      !live.has(channelId) &&
      parentId !== undefined &&
      typeOf(parentId) !== CATEGORY_CHANNEL_TYPE
    );
  };
  const deletedButPublic = (channelId: string): boolean => {
    const record = records.get(channelId);
    return record?.access === 'deleted' && record.everyoneCanView === true;
  };

  const isVisible = (channelId: string): boolean => {
    const type = typeOf(channelId);
    if (type === CATEGORY_CHANNEL_TYPE || rankOf(channelId) > ceiling) return false;
    if ((type !== undefined && THREAD_CHANNEL_TYPES.has(type)) || unknownThread(channelId)) {
      const maybePrivate = type === undefined || type === PRIVATE_THREAD_CHANNEL_TYPE;
      if (isPublic && maybePrivate) return false;
      const parentId = parentOf(channelId);
      if (parentId === undefined) return false;
      const parent = live.get(parentId);
      if (parent === undefined) return !maybePrivate && deletedButPublic(parentId);
      if (!parent.canView || (maybePrivate && !parent.canManageThreads)) return false;
      return !isPublic || parent.audienceCanView;
    }
    const cached = live.get(channelId);
    if (cached !== undefined) return cached.canView && (!isPublic || cached.audienceCanView);
    return deletedButPublic(channelId);
  };

  const visible = new Set<string>();
  for (const channelId of new Set([...records.keys(), ...live.keys()]))
    if (isVisible(channelId)) visible.add(channelId);
  return visible;
};
