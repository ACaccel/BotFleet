/**
 * Integration test for the earthquake plugin's HTTP route.
 *
 * Drives the plugin's real `start` lifecycle hook (a live Express
 * server on an OS-assigned port), POSTs the webhook, and asserts the
 * per-guild broadcast fires. `onShutdown` must release the socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { createEarthquakePlugin } from '../../../src/plugins/earthquake';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import type { Plugin } from '../../../src/core/plugin';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import { buildInertClient } from '../../fixtures/discord/client-builder';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

const BOT = { id: 'bot-1', username: 'bot' };

const buildRegistry = (overrides: Partial<GuildRegistry> = {}): GuildRegistry =>
  ({
    getRepos: () => undefined,
    getChannel: () => undefined,
    getRole: () => undefined,
    ...overrides,
  }) as unknown as GuildRegistry;

/**
 * Port the server bound, read from its listen log line. The plugin is
 * configured with port 0 so concurrent suites never race for a port
 * reserved and released ahead of time.
 */
const boundPort = (infoLines: ReadonlyArray<readonly unknown[]>): number => {
  for (const [msg] of infoLines) {
    const port = /running on port (\d+)/.exec(String(msg))?.[1];
    if (port !== undefined) return Number(port);
  }
  throw new Error('earthquake listen log line not found');
};

let activeShutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await activeShutdown?.();
  activeShutdown = undefined;
});

/** Start the plugin on an OS-assigned port and return that port. */
const startOnFreePort = async (client: Client, registry: GuildRegistry): Promise<number> => {
  const container = createContainer();
  container.registerSingleton(TOKENS.DiscordClient, () => client);
  container.registerSingleton(TOKENS.GuildRegistry, () => registry);

  const logger = silentLogger();
  const info = vi.spyOn(logger, 'info');
  const ctx = buildPluginContext({ logger, resolve: container.resolve.bind(container) });
  const plugin: Plugin = createEarthquakePlugin({ port: 0 });
  await plugin.start?.(ctx);
  activeShutdown = async () => {
    await plugin.onShutdown?.(ctx);
  };
  return boundPort(info.mock.calls);
};

describe('earthquake plugin HTTP route', () => {
  it('broadcasts to configured guilds when the webhook is hit', async () => {
    const { channel, send } = buildSendableChannel();
    const client = buildInertClient({ user: BOT });
    client.guilds.cache.set('g1', buildGuild({ id: 'g1' }));
    const registry = buildRegistry({
      getChannel: () => channel,
      getRole: () => ({ id: 'role-1' }) as never,
    });

    const port = await startOnFreePort(client, registry);

    const res = await fetch(`http://127.0.0.1:${port}/discord/earthquake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);

    // The broadcast is detached from the request; poll for it instead of
    // sleeping a guessed interval, which either flakes on a slow runner
    // or wastes the difference on a fast one.
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });
  });

  it('serves the health check on GET /discord/', async () => {
    const port = await startOnFreePort(buildInertClient({ user: BOT }), buildRegistry());

    const res = await fetch(`http://127.0.0.1:${port}/discord/`);
    expect(res.status).toBe(200);
  });
});
