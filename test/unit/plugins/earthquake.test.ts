/**
 * Unit tests for the earthquake plugin internals: the broadcast
 * fan-out, per-guild error isolation, and the sendEarthquakeAlert
 * no-op guards. The plugin's own HTTP lifecycle is driven end-to-end
 * in `test/integration/plugins/earthquake-route.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import {
  broadcastEarthquakeAlert,
  sendEarthquakeAlert,
} from '../../../src/plugins/earthquake/internal';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import { echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { silentLogger } from '../../fixtures/runtime';

const translator = echoTranslatorWithParams();
const alertFor = (roleId: string): string =>
  `replies:earthquake.alert:${JSON.stringify({ role: roleId })}`;

describe('sendEarthquakeAlert', () => {
  it('sends the translated alert to a sendable channel', async () => {
    const { channel, send } = buildSendableChannel();
    await sendEarthquakeAlert(channel, 'role-1', translator);
    expect(send).toHaveBeenCalledExactlyOnceWith(alertFor('role-1'));
  });

  it('is a no-op for a non-sendable channel', async () => {
    const { channel, send } = buildSendableChannel({ sendable: false });
    await sendEarthquakeAlert(channel, 'role-1', translator);
    expect(send).not.toHaveBeenCalled();
  });

  it('is a no-op when no translator yields an empty message', async () => {
    const { channel, send } = buildSendableChannel();
    await sendEarthquakeAlert(channel, 'role-1', undefined);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('broadcastEarthquakeAlert', () => {
  const buildClient = (guildIds: readonly string[]): Client =>
    ({ guilds: { cache: new Map(guildIds.map((id) => [id, { id }])) } }) as unknown as Client;

  it('broadcasts only to guilds with both an earthquake channel and role', async () => {
    const a = buildSendableChannel();
    const registry: GuildRegistry = {
      getRepos: () => undefined,
      getChannel: (guildId: string) => (guildId === 'a' ? a.channel : undefined),
      getRole: (guildId: string) => (guildId === 'a' ? ({ id: 'role-a' } as never) : undefined),
      listGuildIds: () => ['a', 'b'],
    };

    await broadcastEarthquakeAlert(buildClient(['a', 'b']), registry, translator, silentLogger());
    expect(a.send).toHaveBeenCalledExactlyOnceWith(alertFor('role-a'));
  });

  it('isolates a per-guild failure so other guilds still receive the alert', async () => {
    const bad = buildSendableChannel();
    bad.send.mockRejectedValue(new Error('Missing Permissions'));
    const good = buildSendableChannel();
    const registry: GuildRegistry = {
      getRepos: () => undefined,
      getChannel: (guildId: string) => (guildId === 'bad' ? bad.channel : good.channel),
      getRole: () => ({ id: 'role' }) as never,
      listGuildIds: () => ['bad', 'good'],
    };

    await expect(
      broadcastEarthquakeAlert(buildClient(['bad', 'good']), registry, translator, silentLogger()),
    ).resolves.toBeUndefined();
    expect(bad.send).toHaveBeenCalledOnce();
    expect(good.send).toHaveBeenCalledExactlyOnceWith(alertFor('role'));
  });
});
