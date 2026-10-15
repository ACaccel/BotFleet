/**
 * Composition test for the Nijika personality.
 *
 * Pins nijika's plugin set: the full interactive suite, without
 * `llm-auto-reply` (a gopher-only feature). Adding it here — or dropping
 * one of the registered plugins — is caught by spying on
 * `BaseBot.prototype.use`.
 *
 * It pins the earthquake plugin's wiring: the optional alert port and key
 * and the optional CWA key reach the factory, and the plugin is registered
 * whether or not any of them is set.
 *
 * It pins the `/db` wiring: the db-inspect plugin is registered only when
 * `config.commands` lists `db`, and only with `MONGO_INSPECT_URI`.
 *
 * It also pins the settings service and the
 * feed platform registry, which the `/feed_*` commands resolve through
 * `BaseBot.feedPlatformRegistry` and which must therefore exist before
 * any plugin lifecycle hook has run.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import type * as EarthquakePluginModule from '../../../src/plugins/earthquake/plugin';
import type * as AutoReplyPluginModule from '../../../src/plugins/auto-reply/plugin';
import type * as GuildEventsPluginModule from '../../../src/plugins/guild-events/plugin';
import type * as SocialLinkPreviewPluginModule from '../../../src/plugins/social-link-preview/plugin';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
// Wrap the real factory so the test can read the configuration nijika
// hands it without changing what gets registered.
vi.mock('../../../src/plugins/earthquake/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof EarthquakePluginModule>();
  return { createEarthquakePlugin: vi.fn(actual.createEarthquakePlugin) };
});
vi.mock('../../../src/plugins/auto-reply/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof AutoReplyPluginModule>();
  return { ...actual, createAutoReplyPlugin: vi.fn(actual.createAutoReplyPlugin) };
});
vi.mock('../../../src/plugins/guild-events/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof GuildEventsPluginModule>();
  return { ...actual, createGuildEventsPlugin: vi.fn(actual.createGuildEventsPlugin) };
});
vi.mock('../../../src/plugins/social-link-preview/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof SocialLinkPreviewPluginModule>();
  return { ...actual, createSocialLinkPreviewPlugin: vi.fn(actual.createSocialLinkPreviewPlugin) };
});

import { BaseBot } from '../../../src/bot/index';
import { Nijika } from '../../../src/bot/nijika/nijika';
import type { Plugin } from '../../../src/core/plugin';
import { createEarthquakePlugin } from '../../../src/plugins/earthquake/plugin';
import { createAutoReplyPlugin } from '../../../src/plugins/auto-reply/plugin';
import { createGuildEventsPlugin } from '../../../src/plugins/guild-events/plugin';
import { createSocialLinkPreviewPlugin } from '../../../src/plugins/social-link-preview/plugin';
import { Tomori } from '../../../src/bot/tomori/tomori';

/** Build nijika with the minimum config its constructor requires. */
const buildNijika = (
  config: Record<string, unknown> = {},
  earthquake: ConstructorParameters<typeof Nijika>[5] = {},
  mongoInspectUri?: string,
): Nijika =>
  new Nijika(
    buildInertClient(),
    'token',
    '',
    'bot-client',
    { commands: [], level_roles: {}, ...config },
    earthquake,
    mongoInspectUri,
  );

const collectRegisteredPluginIds = (build: () => Nijika = () => buildNijika()): string[] => {
  const ids: string[] = [];
  const useSpy = vi.spyOn(BaseBot.prototype, 'use').mockImplementation(function (
    this: BaseBot,
    plugin: Plugin,
  ) {
    ids.push(plugin.id);
    return this;
  });
  try {
    build();
  } finally {
    useSpy.mockRestore();
  }
  return ids;
};

describe('Nijika composition', () => {
  it('includes settings once even when deployment commands omit or include it', () => {
    for (const commands of [undefined, [], ['help'], ['help', 'settings']]) {
      const bot = buildNijika({ commands });
      expect(bot.config.commands?.filter((name) => name === 'settings')).toHaveLength(1);
    }
  });

  it('shares its settings policy with automatic replies, event mirrors and social previews', () => {
    const bot = buildNijika({
      commands: ['giveaway'],
      guild_settings: { maxRandomProbability: 0.03, minCooldownSeconds: 3 },
    });
    const settings = bot.guildSettings;
    expect(settings).toBeDefined();
    expect(settings?.capabilities.maxRandomProbability).toBe(0.03);
    expect(settings?.capabilities.minCooldownSeconds).toBe(3);
    expect(settings?.capabilities.features.giveaways).toBe(true);
    expect(settings?.capabilities.features.talk).toBe(false);
    expect(createAutoReplyPlugin).toHaveBeenLastCalledWith(undefined, settings);
    expect(createGuildEventsPlugin).toHaveBeenLastCalledWith(undefined, { settings });
    expect(createSocialLinkPreviewPlugin).toHaveBeenLastCalledWith(undefined, { settings });
  });

  it('does not share runtime settings state with Tomori', () => {
    const nijika = buildNijika();
    const tomori = new Tomori(buildInertClient(), 'token', '', 'tomori-client', { commands: [] });
    expect(nijika.guildSettings).not.toBe(tomori.guildSettings);
  });

  it('rejects invalid operator settings at composition time', () => {
    expect(() => buildNijika({ guild_settings: { maxRandomProbability: 2 } })).toThrow();
    expect(() => buildNijika({ guild_settings: { unknownKey: 1 } })).toThrow();
  });

  it('clears runtime settings when leaving a guild', () => {
    const client = buildInertClient();
    const on = vi.spyOn(client, 'on');
    const bot = new Nijika(client, 'token', '', 'bot-client', { level_roles: {} }, {}, undefined);
    const forget = vi.spyOn(bot.guildSettings!, 'forgetGuild');
    const listener = on.mock.calls.find(([event]) => event === Events.GuildDelete)?.[1];
    expect(listener).toBeDefined();
    listener?.({ id: '200000000000000001' });
    expect(forget).toHaveBeenCalledWith('200000000000000001');
  });

  it('registers its full interactive plugin set', () => {
    expect(new Set(collectRegisteredPluginIds())).toEqual(
      new Set([
        'auto-reply',
        'guild-events',
        'social-link-preview',
        'giveaway',
        'temp-role',
        'bug-report',
        'activity',
        'social-feed',
        'earthquake',
      ]),
    );
  });

  it('no longer registers llm-auto-reply (moved to gopher)', () => {
    expect(collectRegisteredPluginIds()).not.toContain('llm-auto-reply');
  });

  it('binds the feed platform registry before any plugin runs', () => {
    // The `/feed_*` commands read the registry through this getter, and
    // a command can fire before the poller's first pass, so the binding
    // must exist as soon as the constructor returns.
    const registry = buildNijika().feedPlatformRegistry;

    expect(registry).toBeDefined();
    // No `social_feed` block, so no platform is configured — the token
    // is bound all the same.
    expect(registry?.get('x')).toBeUndefined();
  });

  it('registers the platforms the social_feed block names', () => {
    const registry = buildNijika({ social_feed: { platforms: { x: {} } } }).feedPlatformRegistry;

    expect(registry?.get('x')?.id).toBe('x');
  });

  it('hands the earthquake plugin its alert port and key and the CWA key', () => {
    vi.mocked(createEarthquakePlugin).mockClear();
    const alertKey = 'e'.repeat(32);
    buildNijika({}, { alertPort: 4000, alertKey, cwaApiKey: 'cwa-test-key' });
    expect(createEarthquakePlugin).toHaveBeenCalledWith({
      alertPort: 4000,
      alertKey,
      cwaApiKey: 'cwa-test-key',
      alertConfig: undefined,
    });
  });

  it('hands the earthquake plugin its earthquake_alert block and fails fast on a bad one', () => {
    vi.mocked(createEarthquakePlugin).mockClear();
    const block = { ping_min_local_intensity: '5-' };
    buildNijika({ earthquake_alert: block });
    expect(createEarthquakePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ alertConfig: block }),
    );

    expect(() => buildNijika({ earthquake_alert: { ping_min_local_intensity: '8' } })).toThrow(
      /Invalid earthquake_alert config/,
    );
  });

  it('still registers the earthquake plugin with neither feed configured', () => {
    vi.mocked(createEarthquakePlugin).mockClear();
    buildNijika();
    expect(createEarthquakePlugin).toHaveBeenCalledWith({
      alertPort: undefined,
      alertKey: undefined,
      cwaApiKey: undefined,
      alertConfig: undefined,
    });
    expect(collectRegisteredPluginIds()).toContain('earthquake');
  });

  it('registers db-inspect only when config.commands lists db', () => {
    expect(collectRegisteredPluginIds()).not.toContain('db-inspect');
    expect(
      collectRegisteredPluginIds(() =>
        buildNijika({ commands: ['db'] }, {}, 'mongodb://reader@db.example.com:27017'),
      ),
    ).toContain('db-inspect');
  });

  it('refuses to enable db without MONGO_INSPECT_URI', () => {
    expect(() => buildNijika({ commands: ['db'] })).toThrow(/MONGO_INSPECT_URI/);
  });

  it('rejects a malformed platform block at composition time', () => {
    // `.strict()` in the platform schema: an operator's typo must fail
    // the boot rather than silently disable a platform.
    expect(() => buildNijika({ social_feed: { platforms: { x: { unknownKey: 1 } } } })).toThrow();
  });
});
