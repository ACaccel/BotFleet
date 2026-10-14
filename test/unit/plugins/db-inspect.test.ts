/**
 * Unit tests for the db-inspect plugin: it opens the read-only connection
 * with the configured URI, publishes the service the `/db` command reads,
 * propagates an open failure (so the plugin is disabled and `/db` reports
 * itself unavailable), and closes the connection exactly once on shutdown.
 * Also pins how Discord entity names are resolved from the client cache.
 */
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { DbInspectService } from '../../../src/application/db-inspect/service';
import { TOKENS } from '../../../src/bot/tokens';
import type { InspectConnection } from '../../../src/infra/mongo/inspect-connection';
import { createDbInspectPlugin, discordDirectoryFor } from '../../../src/plugins/db-inspect/plugin';
import { buildPluginContext } from '../../fixtures/runtime';

interface FakeClientData {
  readonly guilds?: Readonly<
    Record<string, { name: string; roles?: Readonly<Record<string, string>> }>
  >;
  readonly channels?: Readonly<Record<string, unknown>>;
  readonly users?: Readonly<Record<string, string>>;
  /** Users `users.fetch` can find; others reject. */
  readonly fetchable?: Readonly<Record<string, string>>;
}

const fakeClient = (data: FakeClientData = {}) => {
  const fetch = vi.fn(async (userId: string) => {
    const username = data.fetchable?.[userId];
    if (username === undefined) throw new Error('Unknown User');
    return { username };
  });
  const guilds = new Map(
    Object.entries(data.guilds ?? {}).map(([id, guild]) => [
      id,
      {
        name: guild.name,
        roles: {
          cache: new Map(Object.entries(guild.roles ?? {}).map(([r, name]) => [r, { name }])),
        },
      },
    ]),
  );
  const client = {
    guilds: { cache: guilds },
    channels: { cache: new Map(Object.entries(data.channels ?? {})) },
    users: {
      cache: new Map(Object.entries(data.users ?? {}).map(([id, username]) => [id, { username }])),
      fetch,
    },
  } as unknown as Client;
  return { client, fetch };
};

const fakeConnection = (): InspectConnection & { readonly close: ReturnType<typeof vi.fn> } => ({
  listGuildDatabases: vi.fn(async () => []),
  database: vi.fn(),
  close: vi.fn(async () => undefined),
});

describe('createDbInspectPlugin', () => {
  it('identifies itself', () => {
    const plugin = createDbInspectPlugin({ uri: 'mongodb://inspect' });
    expect(plugin.id).toBe('db-inspect');
    expect(plugin.version).toBe('1.0.0');
  });

  it('opens the configured URI and registers the inspection service', async () => {
    const connection = fakeConnection();
    const open = vi.fn(async () => connection);
    const registerInstance = vi.fn();
    const { client } = fakeClient();
    const plugin = createDbInspectPlugin({ uri: 'mongodb://inspect/db', open });

    await plugin.init?.(
      buildPluginContext({ services: [[TOKENS.DiscordClient, client]], registerInstance }),
    );

    expect(open).toHaveBeenCalledExactlyOnceWith('mongodb://inspect/db');
    expect(registerInstance).toHaveBeenCalledOnce();
    const [token, service] = registerInstance.mock.calls[0] as [unknown, unknown];
    expect(token).toBe(TOKENS.DbInspectService);
    expect(service).toBeInstanceOf(DbInspectService);
  });

  it('lists guild databases through the opened connection', async () => {
    const connection = fakeConnection();
    vi.mocked(connection.listGuildDatabases).mockResolvedValue([{ name: '111', sizeOnDisk: 4096 }]);
    const registerInstance = vi.fn();
    const { client } = fakeClient({ guilds: { '111': { name: 'Home' } } });
    const plugin = createDbInspectPlugin({ uri: 'u', open: async () => connection });

    await plugin.init?.(
      buildPluginContext({ services: [[TOKENS.DiscordClient, client]], registerInstance }),
    );
    const service = registerInstance.mock.calls[0]?.[1] as DbInspectService;

    expect(await service.listGuilds()).toEqual([{ id: '111', sizeOnDisk: 4096, name: 'Home' }]);
  });

  it('reads a guild database through a repository on the connection handle', async () => {
    const connection = fakeConnection();
    vi.mocked(connection.listGuildDatabases).mockResolvedValue([{ name: '111', sizeOnDisk: 1 }]);
    const db = {
      databaseName: '111',
      listCollections: () => ({ toArray: async () => [{ name: 'items', type: 'collection' }] }),
      collection: () => ({ estimatedDocumentCount: async () => 5 }),
    };
    vi.mocked(connection.database).mockReturnValue(db as never);
    const registerInstance = vi.fn();
    const { client } = fakeClient();
    const plugin = createDbInspectPlugin({ uri: 'u', open: async () => connection });

    await plugin.init?.(
      buildPluginContext({ services: [[TOKENS.DiscordClient, client]], registerInstance }),
    );
    const service = registerInstance.mock.calls[0]?.[1] as DbInspectService;

    expect(await service.listCollections('111')).toEqual([
      { name: 'items', estimatedCount: 5, registered: false },
    ]);
    expect(connection.database).toHaveBeenCalledWith('111');
  });

  it('propagates an open failure and registers nothing', async () => {
    const failure = new Error('account can write');
    const registerInstance = vi.fn();
    const { client } = fakeClient();
    const plugin = createDbInspectPlugin({
      uri: 'u',
      open: async () => {
        throw failure;
      },
    });

    await expect(
      plugin.init?.(
        buildPluginContext({ services: [[TOKENS.DiscordClient, client]], registerInstance }),
      ),
    ).rejects.toBe(failure);
    expect(registerInstance).not.toHaveBeenCalled();
    await expect(plugin.onShutdown?.(buildPluginContext())).resolves.toBeUndefined();
  });

  it('closes the connection once on shutdown and tolerates a second call', async () => {
    const connection = fakeConnection();
    const { client } = fakeClient();
    const plugin = createDbInspectPlugin({ uri: 'u', open: async () => connection });
    const ctx = buildPluginContext({
      services: [[TOKENS.DiscordClient, client]],
      registerInstance: vi.fn(),
    });
    await plugin.init?.(ctx);

    await plugin.onShutdown?.(ctx);
    await plugin.onShutdown?.(ctx);

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('shuts down without a connection when init never ran', async () => {
    const plugin = createDbInspectPlugin({ uri: 'u', open: async () => fakeConnection() });
    await expect(plugin.onShutdown?.(buildPluginContext())).resolves.toBeUndefined();
  });
});

describe('discordDirectoryFor', () => {
  it('resolves guild names from the cache', () => {
    const { client } = fakeClient({ guilds: { g1: { name: 'Home' } } });
    const directory = discordDirectoryFor(client);
    expect(directory.guildName('g1')).toBe('Home');
    expect(directory.guildName('other')).toBeUndefined();
  });

  it('resolves channel names only for channels that have a string name', () => {
    const { client } = fakeClient({
      channels: { text: { name: 'general' }, dm: { recipientId: '1' }, odd: { name: 42 } },
    });
    const directory = discordDirectoryFor(client);
    expect(directory.channelName('text')).toBe('general');
    expect(directory.channelName('dm')).toBeUndefined();
    expect(directory.channelName('odd')).toBeUndefined();
    expect(directory.channelName('missing')).toBeUndefined();
  });

  it('resolves role names through the owning guild', () => {
    const { client } = fakeClient({ guilds: { g1: { name: 'Home', roles: { r1: 'Admin' } } } });
    const directory = discordDirectoryFor(client);
    expect(directory.roleName('g1', 'r1')).toBe('Admin');
    expect(directory.roleName('g1', 'missing')).toBeUndefined();
    expect(directory.roleName('other', 'r1')).toBeUndefined();
  });

  it('returns a cached user name without fetching', async () => {
    const { client, fetch } = fakeClient({ users: { u1: 'alice' } });
    const directory = discordDirectoryFor(client);
    expect(await directory.userName('u1', true)).toBe('alice');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches an uncached user only when asked to', async () => {
    const { client, fetch } = fakeClient({ fetchable: { u2: 'bob' } });
    const directory = discordDirectoryFor(client);

    expect(await directory.userName('u2', false)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    expect(await directory.userName('u2', true)).toBe('bob');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('u2');
  });

  it('returns undefined when the fetch fails', async () => {
    const { client, fetch } = fakeClient();
    const directory = discordDirectoryFor(client);
    expect(await directory.userName('gone', true)).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
