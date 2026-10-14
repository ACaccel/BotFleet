/**
 * BaseBot -> ClientEventBridge attachment.
 *
 * The bridge's own routing branches (reactions, GuildCreate onboarding,
 * dispatcher forwarding, listener suppression) are covered against the
 * bridge directly in `client-event-bridge.test.ts`. What only a booted
 * `BaseBot` can show is that `run()` actually installs the bridge on
 * the live client — so one real Discord event fired at the client must
 * come out of the interaction router.
 */
/* eslint-disable import/first */
import { Events } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config } from '../../../src/bot/index';

interface BridgeFakeClient {
  readonly client: Client;
  readonly listeners: Map<string, Array<(...args: unknown[]) => unknown>>;
  fire(event: string, ...args: unknown[]): Promise<void>;
}

const buildBridgeFakeClient = (): BridgeFakeClient => {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const append = (event: string, fn: (...args: unknown[]) => unknown): void => {
    const arr = listeners.get(event) ?? [];
    arr.push(fn);
    listeners.set(event, arr);
  };
  const client = {
    user: { id: 'bot-1', username: 'Botty' },
    guilds: { cache: new Map() },
    channels: { cache: new Map() },
    application: { commands: { set: vi.fn(async () => []) } },
    login: async (t: string) => t,
    destroy: () => {},
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      append(event, fn);
      return client;
    },
    once: (event: string, fn: (...args: unknown[]) => unknown) => {
      append(event, fn);
      return client;
    },
    off: () => client,
  } as unknown as Client;
  return {
    client,
    listeners,
    async fire(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        await fn(...args);
      }
    },
  };
};

class MinimalBot extends BaseBot<Config> {}

describe('BaseBot event-bridge attachment', () => {
  it('routes a client InteractionCreate through the interaction router after run()', async () => {
    const fake = buildBridgeFakeClient();
    const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});
    await bot.run();

    // Spy on the live router the bridge captured during attach so the
    // assertion reflects the production dispatch path rather than a
    // post-hoc property swap.
    const router = (
      bot as unknown as { interactionRouter: { dispatch: (ctx: unknown) => Promise<void> } }
    ).interactionRouter;
    const dispatchSpy = vi.spyOn(router, 'dispatch').mockResolvedValue(undefined);

    const fakeInteraction = {
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      guildId: 'g-1',
      reply: async () => {},
    };
    await fake.fire(Events.InteractionCreate, fakeInteraction);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
