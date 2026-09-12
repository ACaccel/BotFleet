/**
 * Composition test for the Tomori personality.
 *
 * Tomori must register the full interactive plugin set — crucially
 * `guild-events`, which is what subscribes to `messageUpdate` /
 * `messageDelete` / `guildMemberUpdate` / `guildCreate`. A drift where
 * that registration is dropped silently disables all message-event
 * logging (the ClientEventBridge only wires Discord events a plugin
 * subscribes to), and nothing else in the suite would catch it. This
 * test pins the contract by spying on `BaseBot.prototype.use` and
 * asserting the registered plugin ids.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { ActivityType, Events } from 'discord.js';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
vi.mock('@reaction', () => barrelStubs.reaction);

import { BaseBot, type Config } from '../../../src/bot/index';
import { Tomori } from '../../../src/bot/tomori/tomori';
import type { Plugin } from '../../../src/core/plugin';

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
    new Tomori(buildInertClient(), 'token', '', 'bot-client', { commands: [] } satisfies Config);
  } finally {
    useSpy.mockRestore();
  }
  return ids;
};

describe('Tomori composition', () => {
  it('registers the full interactive plugin set including guild-events', () => {
    const ids = collectRegisteredPluginIds();
    expect(new Set(ids)).toEqual(
      new Set([
        'auto-reply',
        'guild-events',
        'social-link-preview',
        'giveaway',
        'temp-role',
        'activity',
      ]),
    );
  });

  it('registers guild-events so message edit/delete events are logged', () => {
    // The reported bug: without this plugin the bot never subscribes to
    // messageUpdate / messageDelete, so no audit log is produced.
    expect(collectRegisteredPluginIds()).toContain('guild-events');
  });
});

describe('Tomori presence', () => {
  const PRESENCE_TEXT = 'presence-status';

  const fakeTranslator = (text: string): NonNullable<Tomori['translator']> =>
    ({
      t: (key: string) => (key === 'replies:tomori.presence_text' ? text : ''),
    }) as unknown as NonNullable<Tomori['translator']>;

  const buildPresenceHarness = (
    options: { nullUser?: boolean } = {},
  ): {
    client: Client;
    fireReady: () => void;
    setPresence: ReturnType<typeof vi.fn>;
  } => {
    let readyHandler: (() => void) | undefined;
    const setPresence = vi.fn();
    const client = {
      user: options.nullUser ? null : { setPresence },
      guilds: { cache: new Map() },
      channels: { cache: new Map() },
      application: null,
      on: () => undefined,
      once: (event: unknown, handler: () => void) => {
        if (event === Events.ClientReady) readyHandler = handler;
        return undefined;
      },
      off: () => undefined,
      destroy: () => undefined,
    } as unknown as Client;
    return { client, fireReady: () => readyHandler?.(), setPresence };
  };

  it('sets a custom online presence from the translated key on ClientReady', () => {
    const { client, fireReady, setPresence } = buildPresenceHarness();
    const bot = new Tomori(client, 'token', '', 'bot-client', { commands: [] } satisfies Config);
    bot.translator = fakeTranslator(PRESENCE_TEXT);

    fireReady();

    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenCalledWith({
      status: 'online',
      activities: [{ name: PRESENCE_TEXT, type: ActivityType.Custom, state: PRESENCE_TEXT }],
    });
  });

  it('skips presence before the translator is bound (pre-run window)', () => {
    const { client, fireReady, setPresence } = buildPresenceHarness();
    // No translator is attached yet, so `this.translator?.t(...) ?? ''`
    // resolves to '' and the guard skips setPresence entirely.
    new Tomori(client, 'token', '', 'bot-client', { commands: [] } satisfies Config);

    fireReady();

    expect(setPresence).not.toHaveBeenCalled();
  });

  it('skips presence when an attached translator yields empty text', () => {
    const { client, fireReady, setPresence } = buildPresenceHarness();
    const bot = new Tomori(client, 'token', '', 'bot-client', { commands: [] } satisfies Config);
    // Translator is present but the key resolves to '' — pins the
    // `text.length === 0` guard independently of the undefined-translator path.
    bot.translator = fakeTranslator('');

    fireReady();

    expect(setPresence).not.toHaveBeenCalled();
  });

  it('does not throw when the client user is not yet available', () => {
    const { client, fireReady, setPresence } = buildPresenceHarness({ nullUser: true });
    const bot = new Tomori(client, 'token', '', 'bot-client', { commands: [] } satisfies Config);
    bot.translator = fakeTranslator(PRESENCE_TEXT);

    // `client.user` is null (login not completed); the `?.` guard must make
    // the ready handler a no-op rather than throwing a TypeError.
    expect(() => fireReady()).not.toThrow();
    expect(setPresence).not.toHaveBeenCalled();
  });
});
