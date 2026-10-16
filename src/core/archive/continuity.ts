import type { ArchiveContinuityBreak, ArchiveGatewayContinuity } from './types';

/**
 * Subtracted from the earliest guild-wide break start when a run derives its rescan
 * bound. It absorbs clock skew and the delay between a dropped connection and the
 * last heartbeat acknowledgement; the overlap window is applied on top.
 */
export const ARCHIVE_RESCAN_SAFETY_MS = 120_000;
/** Pending guild-wide breaks kept apart; older ones merge conservatively beyond it. */
export const ARCHIVE_MAX_GUILD_BREAKS = 100;

const merge = (a: ArchiveContinuityBreak, b: ArchiveContinuityBreak): ArchiveContinuityBreak => ({
  index: Math.max(a.index, b.index),
  start: Math.min(a.start, b.start),
  channelId: a.channelId,
});

/**
 * Adds a break. A pending break of the same channel merges into it, and the oldest
 * guild-wide breaks merge beyond the cap: a merged break starts at the earlier start
 * and settles only with the later index, so coverage never shrinks.
 */
export const addContinuityBreak = (
  breaks: readonly ArchiveContinuityBreak[],
  added: ArchiveContinuityBreak,
): ArchiveContinuityBreak[] => {
  let current = added;
  const next: ArchiveContinuityBreak[] = [];
  for (const entry of breaks)
    if (added.channelId !== null && entry.channelId === added.channelId)
      current = merge(current, entry);
    else next.push(entry);
  next.push(current);
  next.sort((a, b) => a.index - b.index);
  for (;;) {
    const guildWide = next.filter((entry) => entry.channelId === null);
    const [oldest, second] = guildWide;
    if (
      guildWide.length <= ARCHIVE_MAX_GUILD_BREAKS ||
      oldest === undefined ||
      second === undefined
    )
      return next;
    next.splice(next.indexOf(oldest), 1);
    next.splice(next.indexOf(second), 1, merge(oldest, second));
  }
};

/** A complete run created after break `throughIndex` covered it and every earlier break. */
export const settleContinuityBreaks = (
  breaks: readonly ArchiveContinuityBreak[],
  throughIndex: number,
): ArchiveContinuityBreak[] => breaks.filter((entry) => entry.index > throughIndex);

/** Rescan bound of a new incremental run, or `undefined` without a guild-wide break. */
export const continuityRescanFrom = (
  breaks: readonly ArchiveContinuityBreak[],
): number | undefined => {
  const starts = breaks.flatMap((entry) => (entry.channelId === null ? [entry.start] : []));
  return starts.length === 0 ? undefined : Math.min(...starts) - ARCHIVE_RESCAN_SAFETY_MS;
};

/** Sources a new incremental run must scan fully because their visibility changed. */
export const continuityFullChannelIds = (breaks: readonly ArchiveContinuityBreak[]): string[] =>
  breaks.flatMap((entry) => (entry.channelId === null ? [] : [entry.channelId]));

/**
 * Continuity for a new worker boot. Gateway events after the previous boot's last
 * confirmation were not captured, so that confirmation starts a guild-wide break;
 * unsettled breaks and gap state carry over. Without a record (first start, data from
 * before continuity was tracked, or after a rebuild) nothing proves earlier capture
 * was lossless, so a full reconciliation is required.
 *
 * `runGapVersion` is the gap version recorded by the current periodic run. A higher
 * value than the record's means a gap was counted but its write was lost before a
 * crash; the version moves past it so that run cannot settle the lost gap, and a
 * full reconciliation is required.
 */
export const beginArchiveContinuity = (
  previous: ArchiveGatewayContinuity | null,
  bootId: string,
  now: number,
  runGapVersion?: number,
): ArchiveGatewayContinuity => {
  const lostGap = runGapVersion !== undefined && runGapVersion > (previous?.gapVersion ?? -1);
  const gapVersion = lostGap ? runGapVersion + 1 : (previous?.gapVersion ?? 0);
  if (previous === null)
    return {
      bootId,
      continuousSince: now,
      confirmedAt: now,
      fullRequired: true,
      gapVersion,
      breakIndex: 0,
      breaks: [],
    };
  const breakIndex = previous.breakIndex + 1;
  return {
    bootId,
    continuousSince: now,
    confirmedAt: now,
    fullRequired: previous.fullRequired || lostGap,
    gapVersion,
    breakIndex,
    breaks: addContinuityBreak(previous.breaks, {
      index: breakIndex,
      start: previous.confirmedAt,
      channelId: null,
    }),
  };
};
