import { ChannelType, Routes, type Guild, type TextBasedChannel } from 'discord.js';

import { logError, type Logger } from '../../../core/logger';
import {
  discoverGuild,
  historyPermissionGap,
  type DiscoveryGap,
  type DiscoveryLocation,
  type DiscoveryResult,
} from '../flow/discovery';

interface CollectedChannels extends DiscoveryResult {
  channels: TextBasedChannel[];
  liveChannelIds: Set<string>;
}

function describe(channel: unknown): DiscoveryLocation {
  const value = channel as {
    id: string;
    type: number;
    parentId?: string;
    name?: string;
    archivedAt?: Date | null;
  };
  return {
    id: value.id,
    type: value.type,
    parentId: value.parentId,
    name: value.name,
    archivedAt: value.archivedAt?.toISOString(),
    source: channel,
  };
}

/** Fresh SDK objects serve history; raw inventory also exposes unsupported types omitted by the SDK. */
export async function collectChannels(
  guild: Guild,
  logger: Logger,
  options: {
    request?<T>(key: string, operation: () => Promise<T>): Promise<T>;
    concurrency?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CollectedChannels> {
  const request = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
    const result = await (options.request === undefined
      ? operation()
      : options.request(key, operation));
    if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
    return result;
  };
  const inventoryGaps: DiscoveryGap[] = [];
  const discovery = await discoverGuild(
    {
      async channels(): Promise<DiscoveryLocation[]> {
        let locations: DiscoveryLocation[] = [];
        let rawNeeded = false;
        try {
          const fresh = await request(`discovery:${guild.id}:sdk-channels`, () =>
            guild.channels.fetch(),
          );
          locations = [...fresh.values()].filter((channel) => channel !== null).map(describe);
          // The SDK keeps null entries for unsupported raw channel types in its fresh collection.
          rawNeeded = [...fresh.values()].some((channel) => channel === null);
        } catch (error) {
          inventoryGaps.push({ pass: 'channels', reason: `sdk-inventory:${String(error)}` });
          rawNeeded = true;
        }
        if (!rawNeeded) return locations;
        let raw: { id: string; type: number; parent_id?: string; name?: string }[] = [];
        try {
          raw = (await request(`discovery:${guild.id}:raw-channels`, () =>
            guild.client.rest.get(Routes.guildChannels(guild.id), { signal: options.signal }),
          )) as typeof raw;
        } catch (error) {
          inventoryGaps.push({ pass: 'channels', reason: `raw-inventory:${String(error)}` });
        }
        const seen = new Set(locations.map((item) => item.id));
        for (const item of raw) {
          if (!seen.has(item.id))
            locations.push({
              id: item.id,
              type: item.type,
              parentId: item.parent_id,
              name: item.name,
              source: guild.channels.cache.get(item.id),
            });
        }
        return locations;
      },
      async active(): Promise<DiscoveryLocation[]> {
        const result = await request(`discovery:${guild.id}:active`, () =>
          guild.channels.fetchActiveThreads(),
        );
        return [...result.threads.values()].map(describe);
      },
      async archived(parentId, pass, before) {
        const parent = guild.channels.cache.get(parentId);
        if (parent === undefined || !('threads' in parent))
          throw new Error('thread-parent-not-materialized');
        const result = await request(`discovery:${parentId}:${pass}:${before ?? ''}`, () =>
          parent.threads.fetchArchived({
            type: pass === 'public' ? 'public' : 'private',
            fetchAll: pass === 'private',
            limit: 100,
            ...(before === undefined
              ? {}
              : { before: pass === 'joined-private' ? before : new Date(before) }),
          }),
        );
        return {
          locations: [...result.threads.values()].map(describe),
          hasMore: result.hasMore ?? false,
        };
      },
    },
    options,
  );
  discovery.gaps.push(...inventoryGaps);
  const channels: TextBasedChannel[] = [];
  for (const location of discovery.messageLocations) {
    const channel = location.source as TextBasedChannel | undefined;
    if (channel === undefined || !('messages' in channel)) {
      discovery.gaps.push({
        pass: 'history',
        channelId: location.id,
        reason: 'message-channel-not-materialized',
      });
      continue;
    }
    if ('guild' in channel) {
      const reason = historyPermissionGap(channel);
      if (reason !== undefined) {
        discovery.gaps.push({ pass: 'history', channelId: location.id, reason });
        continue;
      }
    }
    channels.push(channel);
  }
  for (const gap of discovery.gaps)
    logError(logger, guild.id, `Discovery ${gap.pass} ${gap.channelId ?? guild.id}: ${gap.reason}`);
  discovery.complete = discovery.gaps.length === 0;
  return {
    ...discovery,
    channels,
    liveChannelIds: new Set(
      discovery.locations
        .filter(
          (item) =>
            item.type !== ChannelType.DM &&
            item.type !== ChannelType.GroupDM &&
            item.type !== ChannelType.GuildCategory,
        )
        .map((item) => item.id),
    ),
  };
}
