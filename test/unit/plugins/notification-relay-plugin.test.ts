/**
 * Notification relay plugin lifecycle: configuration fails fast, the API
 * stays off without a port, and shutdown tolerates a server never started.
 */
import { describe, expect, it } from 'vitest';

import { createNotificationRelayPlugin } from '../../../src/plugins/notification-relay';
import { buildPluginContext, spyLogger } from '../../fixtures/runtime';

const KEY = 'k'.repeat(32);

describe('notification relay plugin', () => {
  it('rejects a port without a long enough key', () => {
    expect(() => createNotificationRelayPlugin({ botId: 'konata', port: 8787 })).toThrow(
      /at least 32 characters/,
    );
    expect(() =>
      createNotificationRelayPlugin({ botId: 'konata', port: 8787, apiKey: 'short' }),
    ).toThrow(/at least 32 characters/);
  });

  it('rejects malformed routes at composition', () => {
    expect(() =>
      createNotificationRelayPlugin({
        botId: 'konata',
        port: 8787,
        apiKey: KEY,
        routes: { deploy: { guildId: 'YOUR_GUILD_ID', channelId: 'x' } },
      }),
    ).toThrow();
  });

  it('logs that it is disabled without a port and binds nothing', async () => {
    const logger = spyLogger();
    const ctx = buildPluginContext({ logger });
    const plugin = createNotificationRelayPlugin({ botId: 'konata', apiKey: KEY });

    await plugin.start?.(ctx);

    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/NOTIFY_API_PORT is not set/));
    await expect(plugin.onShutdown?.(ctx)).resolves.toBeUndefined();
  });

  it('fails startup without a database when no store is injected', async () => {
    const ctx = buildPluginContext();
    const plugin = createNotificationRelayPlugin({ botId: 'konata', port: 0, apiKey: KEY });

    await expect(plugin.start?.(ctx)).rejects.toThrow(/ConnectionManager/);
    await expect(plugin.onShutdown?.(ctx)).resolves.toBeUndefined();
  });
});
