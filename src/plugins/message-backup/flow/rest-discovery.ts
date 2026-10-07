import { Routes, type REST } from 'discord.js';

import type { DiscoveryAdapter, DiscoveryLocation, DiscoveryPage } from './discovery';

export type ArchiveRest = Pick<REST, 'get'>;

function location(raw: unknown): DiscoveryLocation {
  const value = raw as {
    id: string;
    type: number;
    parent_id?: string;
    name?: string;
    thread_metadata?: { archive_timestamp?: string };
  };
  if (typeof value.id !== 'string' || typeof value.type !== 'number')
    throw new Error('invalid-channel-inventory');
  return {
    id: value.id,
    type: value.type,
    parentId: value.parent_id,
    name: value.name,
    archivedAt: value.thread_metadata?.archive_timestamp,
    source: raw,
  };
}

/** The supplied REST manager belongs to msg-archive; this adapter never creates a client. */
export function restDiscoveryAdapter(
  rest: ArchiveRest,
  guildId: string,
  options: {
    signal?: AbortSignal;
    request?<T>(key: string, operation: () => Promise<T>): Promise<T>;
  } = {},
): DiscoveryAdapter {
  const request = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (options.signal?.aborted) throw new Error('archive-discovery-cancelled');
    return options.request === undefined ? operation() : options.request(key, operation);
  };
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  return {
    async channels(): Promise<DiscoveryLocation[]> {
      const raw = await request(`discovery:${guildId}:channels`, () =>
        rest.get(Routes.guildChannels(guildId), signal),
      );
      if (!Array.isArray(raw)) throw new Error('invalid-channel-inventory');
      return raw.map(location);
    },
    async active(): Promise<DiscoveryLocation[]> {
      const raw = (await request(`discovery:${guildId}:active`, () =>
        rest.get(Routes.guildActiveThreads(guildId), signal),
      )) as { threads?: unknown };
      if (!Array.isArray(raw?.threads)) throw new Error('invalid-active-thread-inventory');
      return raw.threads.map(location);
    },
    async archived(parentId, pass, before): Promise<DiscoveryPage> {
      const route =
        pass === 'joined-private'
          ? Routes.channelJoinedArchivedThreads(parentId)
          : Routes.channelThreads(parentId, pass);
      const query = new URLSearchParams({ limit: '100' });
      if (before !== undefined) query.set('before', before);
      const raw = (await request(`discovery:${parentId}:${pass}:${before ?? ''}`, () =>
        rest.get(route, { query, ...signal }),
      )) as { threads?: unknown; has_more?: unknown };
      if (!Array.isArray(raw?.threads) || typeof raw.has_more !== 'boolean')
        throw new Error('invalid-archived-thread-inventory');
      return { locations: raw.threads.map(location), hasMore: raw.has_more };
    },
  };
}
