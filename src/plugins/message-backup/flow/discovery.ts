import { ChannelType, PermissionFlagsBits, type GuildBasedChannel } from 'discord.js';
import { mapArchiveChannels } from './scheduler';

type DiscoveryPass = 'channels' | 'active' | 'public' | 'private' | 'joined-private';
export interface DiscoveryLocation {
  id: string;
  type: number;
  parentId?: string;
  name?: string;
  archivedAt?: string;
  source?: unknown;
  passes?: DiscoveryPass[];
}
export interface DiscoveryGap {
  pass: DiscoveryPass | 'history';
  channelId?: string;
  reason: string;
  /** Discord rejected the request for lack of access rather than failing transiently. */
  forbidden?: true;
}
export interface DiscoveryPage {
  locations: DiscoveryLocation[];
  hasMore: boolean;
}
export interface DiscoveryAdapter {
  channels(): Promise<DiscoveryLocation[]>;
  active(): Promise<DiscoveryLocation[]>;
  archived(
    parentId: string,
    pass: 'public' | 'private' | 'joined-private',
    before?: string,
  ): Promise<DiscoveryPage>;
}
export interface DiscoveryResult {
  locations: DiscoveryLocation[];
  messageLocations: DiscoveryLocation[];
  gaps: DiscoveryGap[];
  complete: boolean;
}

const messageTypes = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);
const containerTypes = new Set<number>([
  ChannelType.GuildCategory,
  ChannelType.GuildDirectory,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);
const threadParents = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

export function isThreadParent(location: Pick<DiscoveryLocation, 'type'>): boolean {
  return threadParents.has(location.type);
}

export function isMessageLocation(location: Pick<DiscoveryLocation, 'type'>): boolean {
  return messageTypes.has(location.type);
}

/** Each endpoint fails independently; joined-private recovery never proves all-private coverage. */
export async function discoverGuild(
  adapter: DiscoveryAdapter,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<DiscoveryResult> {
  if (options.signal?.aborted)
    return {
      locations: [],
      messageLocations: [],
      gaps: [{ pass: 'channels', reason: 'archive-discovery-cancelled' }],
      complete: false,
    };
  const byId = new Map<string, DiscoveryLocation>();
  const gaps: DiscoveryGap[] = [];
  const add = (location: DiscoveryLocation, pass: DiscoveryPass): void => {
    const previous = byId.get(location.id);
    byId.set(location.id, {
      ...location,
      passes: [...new Set([...(previous?.passes ?? []), pass])],
    });
    if (!messageTypes.has(location.type) && !containerTypes.has(location.type)) {
      gaps.push({
        pass: 'channels',
        channelId: location.id,
        reason: `unsupported-channel-type:${location.type}`,
      });
    }
  };
  let parents: DiscoveryLocation[] = [];
  const initial = await Promise.allSettled([
    Promise.resolve().then(() => {
      if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
      return adapter.channels();
    }),
    Promise.resolve().then(() => {
      if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
      return adapter.active();
    }),
  ]);
  try {
    if (initial[0].status === 'rejected') throw initial[0].reason;
    parents = initial[0].value;
    parents.forEach((location) => add(location, 'channels'));
  } catch (error) {
    gaps.push({ pass: 'channels', reason: String(error) });
  }
  try {
    if (initial[1].status === 'rejected') throw initial[1].reason;
    initial[1].value.forEach((location) => add(location, 'active'));
  } catch (error) {
    gaps.push({ pass: 'active', reason: String(error) });
  }

  const drain = async (
    parentId: string,
    pass: 'public' | 'private' | 'joined-private',
  ): Promise<boolean> => {
    let before: string | undefined;
    try {
      for (;;) {
        if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
        const page = await adapter.archived(parentId, pass, before);
        page.locations.forEach((location) => add(location, pass));
        if (!page.hasMore) return true;
        const cursors = page.locations
          .map((location) => (pass === 'joined-private' ? location.id : location.archivedAt))
          .filter((cursor): cursor is string => cursor !== undefined);
        const next = cursors.sort((a, b) => {
          if (pass === 'joined-private')
            return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
          return Date.parse(a) - Date.parse(b);
        })[0];
        const advances =
          next !== undefined &&
          (before === undefined ||
            (pass === 'joined-private'
              ? BigInt(next) < BigInt(before)
              : Date.parse(next) < Date.parse(before)));
        if (!advances || (pass !== 'joined-private' && !Number.isFinite(Date.parse(next!)))) {
          throw new Error('archive-cursor-stalled');
        }
        before = next;
      }
    } catch (error) {
      gaps.push({
        pass,
        channelId: parentId,
        reason: String(error),
        ...(isForbiddenDiscordError(error) ? { forbidden: true } : {}),
      });
      return false;
    }
  };
  await mapArchiveChannels(
    parents.filter((parent) => threadParents.has(parent.type)),
    async (parent) => {
      if (options.signal?.aborted) return;
      await drain(parent.id, 'public');
      if (parent.type === ChannelType.GuildText && !(await drain(parent.id, 'private'))) {
        await drain(parent.id, 'joined-private');
      }
    },
    options.concurrency,
  );
  const locations = [...byId.values()];
  return {
    locations,
    messageLocations: locations.filter((location) => messageTypes.has(location.type)),
    gaps,
    complete: gaps.length === 0,
  };
}

/** Missing permissions are stable coverage limits until an administrator changes them. */
export const PERMISSION_GAPS = [
  'missing-view-channel',
  'missing-read-message-history',
  'missing-connect',
] as const;
export type PermissionGap = (typeof PERMISSION_GAPS)[number];
/**
 * The bot's own member is not cached yet, so permissions are unknown. Unlike a
 * missing permission this is transient and remains a blocking failure.
 */
const MEMBER_UNAVAILABLE = 'bot-member-unavailable';
const UNSUPPORTED_TYPE = /^unsupported-channel-type:/;

export function isPermissionGap(reason: string): reason is PermissionGap {
  return (PERMISSION_GAPS as readonly string[]).includes(reason);
}

/** Discord API access denials: Missing Access / Missing Permissions, or a 403 API error. */
export function isForbiddenDiscordError(
  error: unknown,
): error is { readonly code: number; readonly status?: unknown } {
  // HTTP-only 403s (proxies, gateways) carry no API code and stay blocking.
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if (typeof error.code !== 'number') return false;
  return (
    error.code === 50001 || error.code === 50013 || ('status' in error && error.status === 403)
  );
}

/**
 * Known gaps describe a stable coverage limit (permissions, channel type or a
 * denied thread listing) that retrying cannot close; every other gap is blocking.
 */
export function isKnownDiscoveryGap(gap: DiscoveryGap): boolean {
  switch (gap.pass) {
    case 'history':
      return isPermissionGap(gap.reason);
    case 'channels':
      return UNSUPPORTED_TYPE.test(gap.reason);
    case 'active':
      return false;
    case 'public':
    case 'private':
    case 'joined-private':
      // Listing archived threads requires parent access; a denial is a permission limit.
      return gap.forbidden === true;
    default: {
      const unreachable: never = gap.pass;
      throw new Error(`Unknown discovery pass: ${String(unreachable)}`);
    }
  }
}

/** History access is checked before empty pages can be treated as exhausted. */
export function historyPermissionGap(
  channel: GuildBasedChannel,
): PermissionGap | typeof MEMBER_UNAVAILABLE | undefined {
  const member = channel.guild.members.me;
  if (member === null) return MEMBER_UNAVAILABLE;
  const permissions = channel.permissionsFor(member);
  if (permissions === null || !permissions.has(PermissionFlagsBits.ViewChannel))
    return 'missing-view-channel';
  if (!permissions.has(PermissionFlagsBits.ReadMessageHistory))
    return 'missing-read-message-history';
  if (
    (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) &&
    !permissions.has(PermissionFlagsBits.Connect)
  )
    return 'missing-connect';
  return undefined;
}
