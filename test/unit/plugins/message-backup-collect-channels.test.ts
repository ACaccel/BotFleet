import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../src/core/logger';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';
import {
  discoverGuild,
  historyPermissionGap,
  type DiscoveryAdapter,
  type DiscoveryLocation,
} from '../../../src/plugins/message-backup/flow/discovery';

const loc = (
  id: string,
  type = ChannelType.PublicThread,
  archivedAt?: string,
): DiscoveryLocation => ({ id, type, archivedAt });
function adapter(): DiscoveryAdapter {
  return {
    channels: vi.fn(async () => [loc('1', ChannelType.GuildText)]),
    active: vi.fn(async () => []),
    archived: vi.fn(async () => ({ locations: [], hasMore: false })),
  };
}

describe('complete guild discovery', () => {
  it('inventories voice/stage and all thread containers, but does not scan containers as messages', async () => {
    const api = adapter();
    api.channels = vi.fn(async () => [
      loc('1', ChannelType.GuildText),
      loc('2', ChannelType.GuildVoice),
      loc('3', ChannelType.GuildStageVoice),
      loc('4', ChannelType.GuildForum),
      loc('5', ChannelType.GuildMedia),
      loc('6', ChannelType.GuildAnnouncement),
      loc('7', ChannelType.GuildCategory),
      loc('8', ChannelType.GuildDirectory),
    ]);
    api.active = vi.fn(async () => [
      loc('9', ChannelType.PrivateThread),
      loc('10', ChannelType.AnnouncementThread),
    ]);
    const result = await discoverGuild(api);
    expect(result.complete).toBe(true);
    expect(result.messageLocations.map((item) => item.id)).toEqual(['1', '2', '3', '6', '9', '10']);
    expect(api.active).toHaveBeenCalledTimes(1);
    expect(api.archived).toHaveBeenCalledTimes(5);
  });
  it('uses timestamp archives and thread-id cursors for joined-private fallback', async () => {
    const api = adapter();
    const archived = vi.fn(async (_id: string, pass: string, before?: string) => {
      if (pass === 'private') throw new Error('403');
      if (pass === 'public')
        return before === undefined
          ? {
              locations: [loc('40', ChannelType.PublicThread, '2025-01-01T00:00:00.000Z')],
              hasMore: true,
            }
          : { locations: [], hasMore: false };
      return before === undefined
        ? {
            locations: [loc('30', ChannelType.PrivateThread), loc('20', ChannelType.PrivateThread)],
            hasMore: true,
          }
        : { locations: [loc('10', ChannelType.PrivateThread)], hasMore: false };
    });
    api.archived = archived;
    const result = await discoverGuild(api);
    expect(archived).toHaveBeenCalledWith('1', 'public', '2025-01-01T00:00:00.000Z');
    expect(archived).toHaveBeenCalledWith('1', 'joined-private', '20');
    expect(result.complete).toBe(false);
    expect(result.gaps).toEqual([{ pass: 'private', channelId: '1', reason: 'Error: 403' }]);
    expect(result.messageLocations.map((item) => item.id)).toEqual(['1', '40', '30', '20', '10']);
  });
  it('isolates active/public failures from successful siblings and preserves previous pages', async () => {
    const api = adapter();
    api.active = vi.fn(async () => {
      throw new Error('active denied');
    });
    api.archived = vi.fn(async (_parent, pass, before) => {
      if (pass === 'private')
        return { locations: [loc('8', ChannelType.PrivateThread)], hasMore: false };
      if (before !== undefined) throw new Error('next failed');
      return { locations: [loc('7', ChannelType.PublicThread, '2025-01-01')], hasMore: true };
    });
    const result = await discoverGuild(api);
    expect(result.messageLocations.map((item) => item.id)).toEqual(['1', '7', '8']);
    expect(result.gaps.map((gap) => gap.pass)).toEqual(['active', 'public']);
  });
  it.each(['repeated', 'empty'])('detects %s continuing pages without looping', async (kind) => {
    const api = adapter();
    api.archived = vi.fn(async (_parent, pass) =>
      pass === 'private'
        ? { locations: [], hasMore: false }
        : {
            locations: kind === 'empty' ? [] : [loc('2', ChannelType.PublicThread, '2025-01-01')],
            hasMore: true,
          },
    );
    const result = await discoverGuild(api);
    expect(result.gaps[0]?.reason).toContain('cursor-stalled');
    expect(api.archived).toHaveBeenCalledTimes(kind === 'empty' ? 2 : 3);
  });
  it('deduplicates moved threads and reports unknown raw types', async () => {
    const api = adapter();
    api.channels = vi.fn(async () => [loc('1', ChannelType.GuildText), { id: '99', type: 999 }]);
    api.active = vi.fn(async () => [loc('2')]);
    api.archived = vi.fn(async () => ({ locations: [loc('2')], hasMore: false }));
    const result = await discoverGuild(api);
    expect(result.messageLocations.filter((item) => item.id === '2')).toHaveLength(1);
    expect(result.gaps).toContainEqual({
      pass: 'channels',
      channelId: '99',
      reason: 'unsupported-channel-type:999',
    });
  });
  it('checks history and Connect permissions independently', () => {
    const channel = {
      guild: { members: { me: {} } },
      type: ChannelType.GuildVoice,
      permissionsFor: () => ({
        has: (permission: bigint) => permission !== PermissionFlagsBits.Connect,
      }),
    };
    expect(historyPermissionGap(channel as any)).toBe('missing-connect');
    channel.permissionsFor = () => ({
      has: (permission: bigint) => permission !== PermissionFlagsBits.ReadMessageHistory,
    });
    expect(historyPermissionGap(channel as any)).toBe('missing-read-message-history');
  });
  it('collector uses only fresh SDK inventory when every channel materializes', async () => {
    const channel = { id: '1', type: ChannelType.GuildVoice, messages: {} };
    const channels = {
      cache: new Map([['1', channel]]),
      fetch: vi.fn(async () => new Map([['1', channel]])),
      fetchActiveThreads: vi.fn(async () => ({ threads: new Map() })),
    };
    const get = vi.fn();
    const guild = { id: 'guild', channels, client: { rest: { get } } } as unknown as Guild;
    const logger = { error: vi.fn(), child: () => logger } as unknown as Logger;
    const result = await collectChannels(guild, logger);
    expect(result.complete).toBe(true);
    expect(result.channels.map((item) => item.id)).toEqual(['1']);
    expect(channels.fetch).toHaveBeenCalledTimes(1);
    expect(channels.fetchActiveThreads).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('collector stops before discovery when its job is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const channels = { fetch: vi.fn(), fetchActiveThreads: vi.fn() };
    const guild = { id: 'guild', channels } as unknown as Guild;
    const logger = { error: vi.fn(), child: () => logger } as unknown as Logger;
    const result = await collectChannels(guild, logger, { signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(result.gaps[0]?.reason).toContain('cancelled');
    expect(channels.fetch).not.toHaveBeenCalled();
    expect(channels.fetchActiveThreads).not.toHaveBeenCalled();
  });

  it('collector checks cancellation before admitting the next archived page', async () => {
    const controller = new AbortController();
    const archived = vi.fn(async () => {
      controller.abort();
      return { threads: new Map(), hasMore: true };
    });
    const parent = {
      id: '1',
      type: ChannelType.GuildText,
      messages: {},
      threads: { fetchArchived: archived },
    };
    const channels = {
      cache: new Map([['1', parent]]),
      fetch: vi.fn(async () => new Map([['1', parent]])),
      fetchActiveThreads: vi.fn(async () => ({ threads: new Map() })),
    };
    const guild = { id: 'guild', channels } as unknown as Guild;
    const logger = { error: vi.fn(), child: () => logger } as unknown as Logger;
    const result = await collectChannels(guild, logger, { signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(archived).toHaveBeenCalledTimes(1);
    expect(result.gaps[0]?.reason).toContain('cancelled');
  });

  it('collector uses one guild-active request and flags SDK-omitted raw types', async () => {
    const parent = {
      id: '1',
      type: ChannelType.GuildText,
      messages: { fetch: vi.fn() },
      threads: { fetchArchived: vi.fn(async () => ({ threads: new Map(), hasMore: false })) },
    };
    const channels = {
      cache: new Map([['1', parent]]),
      fetch: vi.fn(
        async () =>
          new Map([
            ['1', parent],
            ['3', null],
          ]),
      ),
      fetchActiveThreads: vi.fn(async () => ({
        threads: new Map([
          ['2', { id: '2', type: ChannelType.PublicThread, messages: { fetch: vi.fn() } }],
        ]),
      })),
    };
    const guild = {
      id: 'guild',
      channels,
      client: {
        rest: {
          get: vi.fn(async () => [
            { id: '1', type: ChannelType.GuildText },
            { id: '3', type: 999 },
          ]),
        },
      },
    } as unknown as Guild;
    const logger = { error: vi.fn(), child: () => logger } as unknown as Logger;
    const result = await collectChannels(guild, logger);
    expect(result.channels.map((channel) => channel.id)).toEqual(['1', '2']);
    expect(channels.fetchActiveThreads).toHaveBeenCalledTimes(1);
    expect(guild.client.rest.get).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
    expect(result.liveChannelIds.has('3')).toBe(true);
  });
});
