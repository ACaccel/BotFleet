import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';

import type { GuildRegistry } from '../../../src/bot/guild-registry';
import {
  FEATURES,
  defaultGuildSettings,
  type GuildSettings,
  type GuildSettingsRuntime,
  type GuildSettingsSnapshot,
  type OperatorCapabilities,
} from '../../../src/core/guild-settings';
import { createFakeClock } from '../../../src/core/time';
import { createAlertDispatcher } from '../../../src/plugins/earthquake/internal/alert-dispatcher';
import type { EarthquakeAlert } from '../../../src/plugins/earthquake/internal/alert-request';
import { broadcastEarthquakeReport } from '../../../src/plugins/earthquake/internal/broadcast';
import type { CwaReport } from '../../../src/plugins/earthquake/internal/cwa-report';
import { resolveEarthquakeDestination } from '../../../src/plugins/earthquake/internal/destination';
import { echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { spyLogger } from '../../fixtures/runtime';

const GUILD_ID = '100000000000000001';
const OTHER_GUILD_ID = '100000000000000002';
const CHANNEL_A = '200000000000000001';
const CHANNEL_B = '200000000000000002';
const ROLE_ID = '300000000000000001';
const capabilities: OperatorCapabilities = {
  features: Object.fromEntries(FEATURES.map((feature) => [feature, false])) as Record<
    (typeof FEATURES)[number],
    boolean
  >,
  earthquake: { alerts: true, reports: true },
  socialProviders: [],
  maxRandomProbability: 1,
  minCooldownSeconds: 0,
  maxPreviewUrls: 5,
};
const ALERT: EarthquakeAlert = {
  epicenterLat: 23.85,
  epicenterLon: 120.82,
  depthKm: 10,
  magnitude: 5.1,
  maxIntensity: '4',
  localIntensity: '3',
  arrivalTime: 1_800_000_000,
  remainingSeconds: 20,
};
const REPORT: CwaReport = {
  number: 1,
  color: undefined,
  content: `report <@&${ROLE_ID}> @everyone`,
  imageUrl: undefined,
  webUrl: undefined,
  originTimeMs: 1_800_000_000_000,
  magnitude: 5.1,
  depthKm: 10,
  epicenter: 'test epicenter',
  areas: [],
};

const buildChannel = (id: string) => {
  const messages: Array<{
    edit: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  }> = [];
  const permissions = { has: vi.fn(() => true) };
  return {
    id,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    isSendable: vi.fn(() => true),
    permissionsFor: vi.fn(() => permissions),
    permissions,
    messages,
    send: vi.fn(async () => {
      const message = { edit: vi.fn(async () => ({})), reply: vi.fn(async () => ({})) };
      messages.push(message);
      return message;
    }),
  };
};

const setup = (preference: Partial<GuildSettings['earthquake']> = {}) => {
  let snapshot: GuildSettingsSnapshot | undefined;
  const defaults = defaultGuildSettings(capabilities);
  const setPreferences = (next: Partial<GuildSettings['earthquake']>) => {
    snapshot = {
      botId: '400000000000000001',
      guildId: GUILD_ID,
      revision: (snapshot?.revision ?? 0) + 1,
      settings: {
        ...defaults,
        earthquake: { ...(snapshot?.settings.earthquake ?? defaults.earthquake), ...next },
      },
      audit: [],
      lastOperationId: 'test',
    };
  };
  setPreferences(preference);
  const settings: GuildSettingsRuntime = {
    get: () => snapshot,
    isEnabled: () => false,
  };
  const a = buildChannel(CHANNEL_A);
  const b = buildChannel(CHANNEL_B);
  const fetchChannel = vi.fn(async (id: string) =>
    id === CHANNEL_A ? a : id === CHANNEL_B ? b : null,
  );
  const role = { id: ROLE_ID, guild: { id: GUILD_ID } };
  const fetchRole = vi.fn(async (): Promise<typeof role | null> => role);
  const member = {};
  const guild = {
    channels: { fetch: fetchChannel },
    roles: { fetch: fetchRole },
    members: { me: member, fetchMe: vi.fn(async () => member) },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
  } as unknown as Client;
  const registry = {
    getChannel: vi.fn(() => b),
    getRole: vi.fn(() => role),
  } as unknown as GuildRegistry;
  const clock = createFakeClock(1_800_000_000_000);
  const logger = spyLogger();
  const translator = echoTranslatorWithParams();
  const dispatcher = createAlertDispatcher({
    client,
    registry,
    settings,
    clock,
    logger,
    translator,
    pingThreshold: '4',
  });
  const broadcast = () =>
    broadcastEarthquakeReport(client, registry, REPORT, translator, logger, settings);
  const resolve = (kind: 'alerts' | 'reports' = 'alerts') =>
    resolveEarthquakeDestination(client, registry, GUILD_ID, kind, settings);
  return {
    a,
    b,
    fetchChannel,
    fetchRole,
    role,
    registry,
    settings,
    dispatcher,
    broadcast,
    resolve,
    setPreferences,
    clearSnapshot: () => {
      snapshot = undefined;
    },
  };
};

const payload = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  mock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

const expectNoOutput = (h: ReturnType<typeof setup>) => {
  expect(h.a.send).not.toHaveBeenCalled();
  expect(h.b.send).not.toHaveBeenCalled();
  expect(h.registry.getChannel).not.toHaveBeenCalled();
  expect(h.registry.getRole).not.toHaveBeenCalled();
};

describe('server earthquake destinations', () => {
  it.each(['defaults', 'disabled', 'missing snapshot', 'missing channel'] as const)(
    'does not fall back to deployment destinations with %s',
    async (state) => {
      const h = setup(
        state === 'disabled'
          ? { channelId: CHANNEL_A }
          : state === 'missing channel'
            ? { alertsEnabled: true, reportsEnabled: true }
            : {},
      );
      if (state === 'missing snapshot') h.clearSnapshot();
      expect(await h.resolve()).toBeUndefined();
      expect(await h.resolve('reports')).toBeUndefined();
      await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
      await h.broadcast();
      expectNoOutput(h);
    },
  );

  it.each([
    { alertsEnabled: true, reportsEnabled: false },
    { alertsEnabled: false, reportsEnabled: true },
  ])('keeps alert and report switches independent: %j', async (preference) => {
    const h = setup({ ...preference, channelId: CHANNEL_A });
    expect((await h.resolve()) !== undefined).toBe(preference.alertsEnabled);
    expect((await h.resolve('reports')) !== undefined).toBe(preference.reportsEnabled);
    await h.dispatcher.dispatch(ALERT);
    expect(h.a.send).toHaveBeenCalledTimes(preference.alertsEnabled ? 1 : 0);
    h.a.send.mockClear();
    await h.broadcast();
    expect(h.a.send).toHaveBeenCalledTimes(preference.reportsEnabled ? 1 : 0);
    expect(h.b.send).not.toHaveBeenCalled();
  });

  it('sends alerts without a role and forbids all mentions', async () => {
    const h = setup({ alertsEnabled: true, channelId: CHANNEL_A });
    expect(await h.resolve()).toMatchObject({ channel: h.a, roleId: undefined });
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    expect(payload(h.a.send)['allowedMentions']).toEqual({ parse: [] });
    expect(String(payload(h.a.send)['content'])).not.toContain('<@&');
    expect(h.fetchRole).not.toHaveBeenCalled();
  });

  it('never mentions a role in reports, including role syntax in upstream content', async () => {
    const h = setup({ reportsEnabled: true, channelId: CHANNEL_A, roleId: ROLE_ID });
    expect(await h.resolve('reports')).toMatchObject({ channel: h.a, roleId: undefined });
    await h.broadcast();
    expect(payload(h.a.send)['allowedMentions']).toEqual({ parse: [] });
    expect(h.fetchRole).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'foreign', 'unsupported', 'unsendable'] as const)(
    'rejects a %s channel before resolving or delivering',
    async (state) => {
      const h = setup({ alertsEnabled: true, reportsEnabled: true, channelId: CHANNEL_A });
      if (state === 'deleted') h.fetchChannel.mockResolvedValue(null);
      if (state === 'foreign') h.a.guildId = OTHER_GUILD_ID;
      if (state === 'unsupported') h.a.type = ChannelType.GuildVoice;
      if (state === 'unsendable') h.a.isSendable.mockReturnValue(false);
      expect(await h.resolve()).toBeUndefined();
      expect(await h.resolve('reports')).toBeUndefined();
      await h.dispatcher.dispatch(ALERT);
      await h.broadcast();
      expectNoOutput(h);
    },
  );

  it.each([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])('rejects delivery when required permission %s is missing', async (missing) => {
    const h = setup({ alertsEnabled: true, reportsEnabled: true, channelId: CHANNEL_A });
    h.a.permissions.has.mockImplementation((...args: unknown[]) => {
      const required = args[0] as readonly bigint[];
      return !required.includes(missing);
    });
    expect(await h.resolve()).toBeUndefined();
    await h.dispatcher.dispatch(ALERT);
    await h.broadcast();
    expectNoOutput(h);
  });

  it.each(['deleted', 'foreign', 'everyone'] as const)(
    'does not ping a %s role while retaining the valid destination',
    async (state) => {
      const h = setup({
        alertsEnabled: true,
        channelId: CHANNEL_A,
        roleId: state === 'everyone' ? GUILD_ID : ROLE_ID,
      });
      if (state === 'deleted') h.fetchRole.mockResolvedValue(null);
      if (state === 'foreign') h.role.guild.id = OTHER_GUILD_ID;
      expect(await h.resolve()).toMatchObject({ channel: h.a, roleId: undefined });
      await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
      expect(payload(h.a.send)['allowedMentions']).toEqual({ parse: [] });
      expect(String(payload(h.a.send)['content'])).not.toContain('<@&');
    },
  );

  it.each(['alerts', 'reports'] as const)(
    'abandons %s when server preferences change during destination lookup',
    async (kind) => {
      const h = setup({ alertsEnabled: true, reportsEnabled: true, channelId: CHANNEL_A });
      h.fetchChannel.mockImplementationOnce(async () => {
        h.setPreferences({ alertsEnabled: false, reportsEnabled: false });
        return h.a;
      });
      if (kind === 'alerts') await h.dispatcher.dispatch(ALERT);
      else await h.broadcast();
      expectNoOutput(h);
    },
  );
});

describe('earthquake event updates after server settings change', () => {
  it('posts in the new channel instead of editing the previous destination', async () => {
    const h = setup({ alertsEnabled: true, channelId: CHANNEL_A });
    await h.dispatcher.dispatch(ALERT);
    h.setPreferences({ channelId: CHANNEL_B });
    await h.dispatcher.dispatch(ALERT);
    expect(h.a.send).toHaveBeenCalledOnce();
    expect(h.b.send).toHaveBeenCalledOnce();
    expect(h.a.messages[0]?.edit).not.toHaveBeenCalled();
    expect(h.a.messages[0]?.reply).not.toHaveBeenCalled();
  });

  it('neither edits nor replies when alerts are disabled during an event', async () => {
    const h = setup({ alertsEnabled: true, channelId: CHANNEL_A, roleId: ROLE_ID });
    await h.dispatcher.dispatch(ALERT);
    h.setPreferences({ alertsEnabled: false });
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    expect(h.a.send).toHaveBeenCalledOnce();
    expect(h.a.messages[0]?.edit).not.toHaveBeenCalled();
    expect(h.a.messages[0]?.reply).not.toHaveBeenCalled();
  });

  it('does not ping a removed role when a later alert reaches the threshold', async () => {
    const h = setup({ alertsEnabled: true, channelId: CHANNEL_A, roleId: ROLE_ID });
    await h.dispatcher.dispatch(ALERT);
    h.setPreferences({ roleId: null });
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    const message = h.a.messages[0]!;
    expect(message.edit).toHaveBeenCalledOnce();
    expect(payload(message.edit)['allowedMentions']).toEqual({ parse: [] });
    expect(String(payload(message.edit)['content'])).not.toContain('<@&');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'role removed'] as const)(
    'does not send an upgrade reply when settings become %s during the message edit',
    async (state) => {
      const h = setup({ alertsEnabled: true, channelId: CHANNEL_A, roleId: ROLE_ID });
      await h.dispatcher.dispatch(ALERT);
      const message = h.a.messages[0]!;
      message.edit.mockImplementation(async () => {
        h.setPreferences(state === 'disabled' ? { alertsEnabled: false } : { roleId: null });
        return {};
      });
      await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
      expect(message.edit).toHaveBeenCalledOnce();
      expect(message.reply).not.toHaveBeenCalled();
    },
  );

  it('removes a stale role mention from updates after a previous ping', async () => {
    const h = setup({ alertsEnabled: true, channelId: CHANNEL_A, roleId: ROLE_ID });
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    expect(payload(h.a.send)['allowedMentions']).toEqual({ roles: [ROLE_ID] });
    h.setPreferences({ roleId: null });
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '5-' });
    const message = h.a.messages[0]!;
    expect(payload(message.edit)['allowedMentions']).toEqual({ parse: [] });
    expect(String(payload(message.edit)['content'])).not.toContain('<@&');
    expect(message.reply).not.toHaveBeenCalled();
  });
});
