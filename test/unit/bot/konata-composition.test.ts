/**
 * Composition test for the Konata personality: LLM chat plus the
 * notification relay API, which receives the env port and key and the
 * `notificationRoutes` block, and fails construction on a malformed block.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import type * as NotificationRelayPluginModule from '../../../src/plugins/notification-relay/plugin';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
vi.mock('../../../src/plugins/notification-relay/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationRelayPluginModule>();
  return { createNotificationRelayPlugin: vi.fn(actual.createNotificationRelayPlugin) };
});

import { BaseBot } from '../../../src/bot/index';
import { Konata } from '../../../src/bot/konata/konata';
import type { Plugin } from '../../../src/core/plugin';
import { createNotificationRelayPlugin } from '../../../src/plugins/notification-relay/plugin';

const KEY = 'k'.repeat(32);
const ROUTES = {
  'card-together-deploy': { guildId: '123456789012345678', channelId: '223456789012345678' },
};

const buildKonata = (
  config: Record<string, unknown> = {},
  notifyApi?: { port?: number; apiKey?: string },
): Konata =>
  new Konata(
    buildInertClient(),
    'token',
    '',
    'konata-client',
    { commands: [], ...config },
    notifyApi,
  );

const registeredIds = (build: () => Konata): string[] => {
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

describe('Konata composition', () => {
  it('registers LLM chat and the notification relay, which stays off without a port', () => {
    vi.mocked(createNotificationRelayPlugin).mockClear();

    expect(registeredIds(() => buildKonata())).toEqual(['llm-chat', 'notification-relay']);
    expect(createNotificationRelayPlugin).toHaveBeenCalledWith({
      botId: 'konata-client',
      port: undefined,
      apiKey: undefined,
      routes: undefined,
    });
  });

  it('hands the relay its env port, key and routes', () => {
    vi.mocked(createNotificationRelayPlugin).mockClear();

    buildKonata({ notificationRoutes: ROUTES }, { port: 8787, apiKey: KEY });

    expect(createNotificationRelayPlugin).toHaveBeenCalledWith({
      botId: 'konata-client',
      port: 8787,
      apiKey: KEY,
      routes: ROUTES,
    });
  });

  it('refuses to start with malformed routes', () => {
    expect(() =>
      buildKonata({ notificationRoutes: { deploy: { guildId: 'YOUR_GUILD_ID' } } }),
    ).toThrow();
  });
});
