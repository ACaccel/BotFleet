import type { GuildBasedChannel } from 'discord.js';
import type { ArchiveChannel, ArchiveHistoryCheckpoint } from '../../../core/archive/types';
import type { DiscoveryGap, DiscoveryLocation } from '../flow/discovery';
import { everyoneCanView } from './channel-location';
import type { HistoryPageResult } from './ingestor';

/**
 * The `archive_channels` record discovery writes for an inventoried location.
 * Checkpoints change only through the checkpoint hook; the parent is authoritative.
 */
export const inventoriedChannel = (
  previous: ArchiveChannel | undefined,
  location: DiscoveryLocation,
  gaps: readonly DiscoveryGap[],
  readable: boolean,
  visible: boolean | undefined,
  runId: string,
): ArchiveChannel => {
  const reasons = gaps
    .filter((gap) => gap.channelId === location.id || gap.channelId === undefined)
    .map((gap) => `${gap.pass}:${gap.reason}`);
  const denied = reasons.some((reason) => reason.includes('missing-') || reason.includes('403'));
  const { checkpoints: _checkpoints, parentId: _parent, ...known } = previous ?? {};
  const name = location.name ?? previous?.name;
  return {
    ...known,
    channelId: location.id,
    ...(name === undefined ? {} : { name }),
    type: location.type,
    observedAt: Date.now(),
    ...(visible === undefined ? {} : { everyoneCanView: visible }),
    access: readable ? 'readable' : denied ? 'denied' : 'unknown',
    parentId: location.parentId,
    discovery: {
      runId,
      ...(location.passes === undefined ? {} : { passes: location.passes }),
      gaps: reasons,
      verifiedAt: Date.now(),
      scope: location.passes?.includes('joined-private')
        ? 'joined-private'
        : 'accessible-inventory',
    },
  };
};

/** The `archive_channels` record a source revalidation writes. */
export const revalidatedChannel = (
  previous: ArchiveChannel | undefined,
  channelId: string,
  access: ArchiveChannel['access'],
  channel: GuildBasedChannel | undefined,
  reason: string | undefined,
  runId: string,
): ArchiveChannel => {
  const { checkpoints: _checkpoints, ...known } = previous ?? {};
  const visible = everyoneCanView(channel);
  const name = channel?.name ?? previous?.name;
  const type = channel?.type ?? previous?.type;
  return {
    ...known,
    channelId,
    ...(name === undefined ? {} : { name }),
    ...(type === undefined ? {} : { type }),
    observedAt: Date.now(),
    ...(visible === undefined ? {} : { everyoneCanView: visible }),
    access,
    // A channel that could not be fetched (deleted or hidden) keeps its last parent.
    parentId: channel === undefined ? previous?.parentId : (channel.parentId ?? undefined),
    discovery: {
      runId,
      gaps: reason === undefined || access === 'deleted' ? [] : [reason],
      verifiedAt: Date.now(),
    },
  };
};

/** A source's cumulative statistics after one more page. */
export const pageStatistics = (
  previous: ArchiveHistoryCheckpoint['statistics'],
  page: HistoryPageResult,
  pageAdmitted: number,
): NonNullable<ArchiveHistoryCheckpoint['statistics']> => ({
  messages: {
    fetched: 0,
    scanned: (previous?.messages.scanned ?? 0) + page.admitted.length,
    admitted: (previous?.messages.admitted ?? 0) + pageAdmitted,
    excluded: (previous?.messages.excluded ?? 0) + Math.max(0, page.admitted.length - pageAdmitted),
    inserted: (previous?.messages.inserted ?? 0) + page.counts.inserted,
    updated: (previous?.messages.updated ?? 0) + page.counts.updated,
    unchanged: (previous?.messages.unchanged ?? 0) + page.counts.unchanged,
    durable: (previous?.messages.durable ?? 0) + page.counts.durable,
  },
  reactions: (previous?.reactions ?? 0) + page.reactions,
  staleReactions: (previous?.staleReactions ?? 0) + page.staleReactions,
});
