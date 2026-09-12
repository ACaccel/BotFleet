/**
 * Composition test for the Nijika personality.
 *
 * Pins nijika's plugin set: the full interactive suite, without
 * `llm-auto-reply` (a gopher-only feature). Adding it here — or dropping
 * one of the registered plugins — is caught by spying on
 * `BaseBot.prototype.use`.
 *
 * It also pins the one service nijika's constructor binds itself: the
 * feed platform registry, which the `/feed_*` commands resolve through
 * `BaseBot.feedPlatformRegistry` and which must therefore exist before
 * any plugin lifecycle hook has run.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
vi.mock('@reaction', () => barrelStubs.reaction);

import { BaseBot } from '../../../src/bot/index';
import { Nijika } from '../../../src/bot/nijika/nijika';
import type { Plugin } from '../../../src/core/plugin';

/** Build nijika with the minimum config its constructor requires. */
const buildNijika = (config: Record<string, unknown> = {}): Nijika =>
  new Nijika(
    buildInertClient(),
    'token',
    '',
    'bot-client',
    { commands: [], level_roles: {}, ...config },
    3000,
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

  it('refuses to boot on a config that still declares the retired x_media_feed block', () => {
    // Nothing validates the top level of a bot config, so a stale block
    // would otherwise be read by nobody and the feed would go silently
    // dark instead of failing the migration loudly.
    expect(() => buildNijika({ x_media_feed: { enabled: true } })).toThrow(/social_feed/);
  });

  it('rejects a malformed platform block at composition time', () => {
    // `.strict()` in the platform schema: an operator's typo must fail
    // the boot rather than silently disable a platform.
    expect(() => buildNijika({ social_feed: { platforms: { x: { unknownKey: 1 } } } })).toThrow();
  });
});
