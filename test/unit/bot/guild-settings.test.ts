/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import { Collection, ChannelType } from 'discord.js';
import type { GuildSettingsServiceOptions } from '../../../src/application/guild-settings/service';
const hooks = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('../../../src/application/guild-settings/service', () => ({
  GuildSettingsService: vi.fn(function (options: GuildSettingsServiceOptions) {
    hooks.options(options);
  }),
}));
import { createGuildSettings } from '../../../src/bot/guild-settings';
import {
  defaultGuildSettings,
  cloneSettings,
  type GuildSettingsActor,
} from '../../../src/core/guild-settings';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

const identity = {
  botId: '100000000000000001',
  guildId: '200000000000000001',
  userId: '300000000000000001',
};
const actor: GuildSettingsActor = { ...identity, manager: true, roleIds: [] };
const build = (
  config: Parameters<typeof createGuildSettings>[1] = {},
  capabilities: Parameters<typeof createGuildSettings>[2] = {},
) => {
  const permissions = { has: vi.fn(() => true) };
  const member = { roles: { cache: new Collection() }, permissions };
  const fetch = vi.fn(async () => member);
  const fetchChannel = vi.fn();
  const guild = {
    id: identity.guildId,
    ownerId: '400000000000000001',
    members: { fetch, me: {} },
    channels: { cache: new Collection(), fetch: fetchChannel },
    roles: { fetch: vi.fn() },
  };
  const { bot } = buildFakeBot({
    clientId: identity.botId,
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
  });
  createGuildSettings(
    bot,
    {
      commands: ['giveaway', 'talk'],
      guild_settings: { maxRandomProbability: 0.05, minCooldownSeconds: 2 },
      ...config,
    },
    capabilities,
  );
  const options = hooks.options.mock.lastCall?.[0] as GuildSettingsServiceOptions;
  return { options, permissions, fetch, fetchChannel, guild };
};

describe('Shared guild settings composition', () => {
  it('does not seed Tomori earthquake delivery even when both sources are available', async () => {
    const { options } = build({}, { earthquake: { alerts: true, reports: true } });
    expect(options.capabilities.earthquake).toEqual({ alerts: true, reports: true });
    expect((await options.legacySeed(identity.guildId)).earthquake).toEqual({
      alertsEnabled: false,
      reportsEnabled: false,
      channelId: null,
      roleId: null,
    });
  });
  it('accepts enabled earthquake notifications without a role and rechecks destination permissions', async () => {
    const { options, fetchChannel } = build({}, { earthquake: { alerts: true, reports: true } });
    const committed = defaultGuildSettings(options.capabilities);
    committed.earthquake.channelId = '500000000000000001';
    const draft = cloneSettings(committed);
    draft.earthquake.alertsEnabled = true;
    const has = vi.fn(() => true);
    fetchChannel.mockResolvedValue({
      guildId: identity.guildId,
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has }),
    });
    await expect(options.validateResources?.(draft, actor, committed)).resolves.toBeUndefined();
    expect(fetchChannel).toHaveBeenCalled();
    has.mockReturnValue(false);
    await expect(options.validateResources?.(draft, actor, committed)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
  it.each(['missing', 'foreign', 'everyone'])(
    'rejects an %s earthquake notification role',
    async (kind) => {
      const { options, guild } = build();
      const committed = defaultGuildSettings(options.capabilities);
      const draft = cloneSettings(committed);
      draft.earthquake.roleId = kind === 'everyone' ? identity.guildId : '600000000000000001';
      guild.roles.fetch.mockResolvedValue(
        kind === 'missing'
          ? null
          : { guild: { id: kind === 'foreign' ? '200000000000000002' : identity.guildId } },
      );
      await expect(options.validateResources?.(draft, actor, committed)).rejects.toMatchObject({
        code: 'invalid',
      });
    },
  );
  it('seeds only supported destinations and leaves deployment-only settings intact', async () => {
    const channels = {
      debug: '500000000000000001',
      event: '500000000000000002',
      giveaway: '500000000000000003',
      earthquake: '500000000000000004',
    };
    const { options } = build({ guilds: { [identity.guildId]: { channels } } });
    const seed = await options.legacySeed(identity.guildId);
    expect(seed.channels).toEqual({
      debug: channels.debug,
      event: channels.event,
      giveaway: channels.giveaway,
    });
    expect(seed.autoReply.cooldownSeconds).toBe(2);
    expect(seed.features.giveaways.enabled).toBe(true);
  });

  it('forces a current member read rather than authorizing a cached role', async () => {
    const { options, fetch, permissions } = build();
    permissions.has.mockReturnValue(false);
    const current = await options.resolveActor?.(identity);
    expect(fetch).toHaveBeenCalledWith({ user: identity.userId, force: true });
    expect(current?.manager).toBe(false);
    expect(current?.roleIds).toEqual([]);
  });
  it('rejects a destination belonging to another server', async () => {
    const { options, fetchChannel } = build();
    const committed = defaultGuildSettings(options.capabilities);
    const draft = cloneSettings(committed);
    draft.channels.debug = '500000000000000001';
    fetchChannel.mockResolvedValue({ guildId: '200000000000000002', type: ChannelType.GuildText });
    await expect(options.validateResources?.(draft, actor, committed)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
  it('rechecks management authority before committing protected settings', async () => {
    const { options, permissions } = build();
    const committed = defaultGuildSettings(options.capabilities);
    const draft = cloneSettings(committed);
    draft.access.mode = 'everyone';
    permissions.has.mockReturnValue(false);
    await expect(options.validateResources?.(draft, actor, committed)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('does not require access to an unchanged private destination for a delegated edit', async () => {
    const { options, fetchChannel, permissions } = build();
    const committed = defaultGuildSettings(options.capabilities);
    committed.channels.debug = '500000000000000001';
    committed.access = { mode: 'everyone', roleIds: [], categories: ['auto_reply'] };
    const draft = cloneSettings(committed);
    draft.autoReply.probability = 0.01;
    permissions.has.mockReturnValue(false);
    await expect(
      options.validateResources?.(draft, { ...actor, manager: false }, committed),
    ).resolves.toBeUndefined();
    expect(fetchChannel).not.toHaveBeenCalled();
  });
  it('constrains guild preferences to the configured deployment capabilities', () => {
    const { options } = build();
    expect(options.capabilities.maxRandomProbability).toBe(0.05);
    expect(options.capabilities.minCooldownSeconds).toBe(2);
    expect(options.capabilities.features.giveaways).toBe(true);
    expect(options.capabilities.features.social_preview).toBe(false);
  });
});
