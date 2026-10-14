/**
 * Composition test for the Nijika personality.
 *
 * Pins nijika's plugin set: the full interactive suite, without
 * `llm-auto-reply` (a gopher-only feature). Adding it here — or dropping
 * one of the registered plugins — is caught by spying on
 * `BaseBot.prototype.use`.
 *
 * It pins the earthquake plugin's wiring: the webhook port and the
 * optional CWA key reach the factory, and the plugin is registered
 * whether or not a key is set.
 *
 * It also pins the one service nijika's constructor binds itself: the
 * feed platform registry, which the `/feed_*` commands resolve through
 * `BaseBot.feedPlatformRegistry` and which must therefore exist before
 * any plugin lifecycle hook has run.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import type * as EarthquakePluginModule from '../../../src/plugins/earthquake/plugin';
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

import { BaseBot } from '../../../src/bot/index';
import { Nijika } from '../../../src/bot/nijika/nijika';
import type { Plugin } from '../../../src/core/plugin';
import { createEarthquakePlugin } from '../../../src/plugins/earthquake/plugin';

/** Build nijika with the minimum config its constructor requires. */
const buildNijika = (config: Record<string, unknown> = {}, cwaApiKey?: string): Nijika =>
  new Nijika(
    buildInertClient(),
    'token',
    '',
    'bot-client',
    { commands: [], level_roles: {}, ...config },
    3000,
    cwaApiKey,
  );

const collectRegisteredPluginIds = (): string[] => {
  const ids: string[] = [];
  const useSpy = vi.spyOn(BaseBot.prototype, 'use').mockImplementation(function (
    this: BaseBot,
    plugin: Plugin,
  ) {
    ids.push(plugin.id);
    return this;
  });
  try {
    buildNijika();
  } finally {
    useSpy.mockRestore();
  }
  return ids;
};

describe('Nijika composition', () => {
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

  it('hands the earthquake plugin its webhook port and the CWA key', () => {
    vi.mocked(createEarthquakePlugin).mockClear();
    buildNijika({}, 'cwa-test-key');
    expect(createEarthquakePlugin).toHaveBeenCalledWith({ port: 3000, cwaApiKey: 'cwa-test-key' });
  });

  it('still registers the earthquake webhook without a CWA key', () => {
    vi.mocked(createEarthquakePlugin).mockClear();
    buildNijika();
    expect(createEarthquakePlugin).toHaveBeenCalledWith({ port: 3000, cwaApiKey: undefined });
    expect(collectRegisteredPluginIds()).toContain('earthquake');
  });

  it('rejects a malformed platform block at composition time', () => {
    // `.strict()` in the platform schema: an operator's typo must fail
    // the boot rather than silently disable a platform.
    expect(() => buildNijika({ social_feed: { platforms: { x: { unknownKey: 1 } } } })).toThrow();
  });
});
