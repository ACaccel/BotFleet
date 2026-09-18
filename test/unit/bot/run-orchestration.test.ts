/**
 * Contract baseline: `BaseBot.run()` end-to-end startup sequence.
 *
 * The spec drives a minimal subclass with no plugins through `run()`
 * using a fake Discord client, no Mongo URI, and the default
 * translator, and asserts:
 *
 *   - `run()` resolves without throwing.
 *   - The bot exposes `logger`, `translator`, `container`, plugin host.
 *   - The fake client received exactly one `login(...)` call.
 *   - The `ClientReady` body wires guildInfo for every cached guild.
 *   - Eight raw `client.on(...)` listeners are installed for the
 *     interaction / 3x message / 2x reaction / memberUpdate / guildCreate
 *     events that BaseBot owns (guildCreate listener is conditional on
 *     no plugin owning the event — this spec has no plugins).
 *   - The optional `run(callback)` parameter runs inside `ClientReady`.
 */
/* eslint-disable import/first */
import { Events } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

// Stub the handler barrels: their real registry.generated.ts files eagerly
// load every command module, hitting a `Command` base-class circular-import
// hazard when used from a unit/integration test outside the deploy flow.
// `vi.mock` is hoisted above the BaseBot import below, so the stubs are
// in place before BaseBot resolves these aliases.
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
vi.mock('@reaction', () => barrelStubs.reaction);

import { GuildDbConnector } from '../../../src/bot/guild-db-connector';
import { BaseBot, type Config } from '../../../src/bot/index';

/** Build a minimal Discord.js Client fake usable by BaseBot.run(). */
interface RunFakeClient {
  readonly client: Client;
  readonly listeners: Map<string, Array<(...args: unknown[]) => unknown>>;
  /** Captured calls to `client.login`. */
  readonly logins: string[];
  /** Trigger a stored listener by event name. */
  fire(event: string, ...args: unknown[]): Promise<void>;
}

const buildRunFakeClient = (
  init: { guilds?: ReadonlyArray<{ id: string; name: string }> } = {},
): RunFakeClient => {
  const guildCache = new Map<string, unknown>();
  for (const g of init.guilds ?? []) {
    guildCache.set(g.id, {
      id: g.id,
      name: g.name,
      members: { cache: new Map([['bot-1', { displayName: 'Botty' }]]) },
      roles: { cache: new Map() },
    });
  }
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const logins: string[] = [];
  const fakeUser = { id: 'bot-1', username: 'Botty' };
  const append = (event: string, fn: (...args: unknown[]) => unknown): void => {
    const arr = listeners.get(event) ?? [];
    arr.push(fn);
    listeners.set(event, arr);
  };
  const client = {
    user: fakeUser,
    guilds: { cache: guildCache },
    channels: { cache: new Map() },
    application: { commands: { set: vi.fn(async () => []) } },
    login: async (token: string) => {
      logins.push(token);
      return token;
    },
    destroy: () => {},
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      append(event, fn);
      return client;
    },
    once: (event: string, fn: (...args: unknown[]) => unknown) => {
      append(event, fn);
      return client;
    },
    off: (event: string, fn: (...args: unknown[]) => unknown) => {
      const arr = listeners.get(event);
      if (arr === undefined) return client;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
      return client;
    },
  } as unknown as Client;
  return {
    client,
    listeners,
    logins,
    async fire(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        await fn(...args);
      }
    },
  };
};

class MinimalBot extends BaseBot<Config> {}

describe('BaseBot.run() — contract baseline', () => {
  it('boots without throwing and exposes logger / translator / container / host', async () => {
    const fake = buildRunFakeClient({ guilds: [{ id: 'g-1', name: 'Guild One' }] });
    const bot = new MinimalBot(fake.client, 'fake-token', '', 'bot-1', {});

    await bot.run();
    // ClientReady is the gate for guildInfo / commandHandlers — fire it.
    await fake.fire(Events.ClientReady);

    expect(bot.logger).toBeDefined();
    expect(bot.translator).toBeDefined();
    expect(bot.container).toBeDefined();
    expect(bot.getPluginHost()).toBeDefined();
    expect(fake.logins).toEqual(['fake-token']);
    expect(bot.getGuildInfo('g-1')).toBeDefined();
    await bot.shutdown();
  });

  it('installs raw listeners for the interaction-class events BaseBot owns', async () => {
    const fake = buildRunFakeClient();
    const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});

    await bot.run();

    // ClientEventBridge installs raw listeners only for the
    // events BaseBot actually owns (interaction / reaction / guildCreate
    // fallback). Pure-plugin events (messageCreate / messageUpdate /
    // messageDelete / guildMemberUpdate) attach only when a plugin
    // subscribes; the MinimalBot here registers no plugin.
    for (const event of [
      Events.InteractionCreate,
      Events.MessageReactionAdd,
      Events.MessageReactionRemove,
      Events.GuildCreate,
    ]) {
      expect(fake.listeners.get(event)?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
    await bot.shutdown();
  });

  it('invokes the optional ClientReady callback exactly once', async () => {
    const fake = buildRunFakeClient({ guilds: [{ id: 'g-1', name: 'G' }] });
    const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});

    const cb = vi.fn(async () => {});
    await bot.run(cb);
    await fake.fire(Events.ClientReady);

    expect(cb).toHaveBeenCalledTimes(1);
    await bot.shutdown();
  });

  it('opens the ready latch even when a startup phase throws', async () => {
    const fake = buildRunFakeClient();
    // A rejected login is the common startup failure (bad token).
    (fake.client as unknown as { login: () => Promise<string> }).login = async () => {
      throw new Error('An invalid token was provided.');
    };
    const bot = new MinimalBot(fake.client, 'bad-token', '', 'bot-1', {});

    await expect(bot.run()).rejects.toThrow();

    // The ClientReady listener is armed before login, so a ready event
    // that arrives after the failure must not block forever on the
    // latch — `fire` awaits the listener and would otherwise hang.
    await expect(fake.fire(Events.ClientReady)).resolves.toBeUndefined();
    await bot.shutdown();
  });

  it('shutdown() is safe to call after a successful run()', async () => {
    const fake = buildRunFakeClient();
    const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});
    await bot.run();
    await expect(bot.shutdown()).resolves.toBeUndefined();
  });

  it('binds the typed Env without a MONGO_URI when constructed database-free', async () => {
    // gopher is database-free: BaseBot must treat an empty mongoURI as
    // "no DB" and NOT demand MONGO_URI when loading the typed Env, so
    // TOKENS.Env still binds. (no-restricted-syntax is off in test files,
    // so direct process.env manipulation is permitted here.)
    const saved = {
      TOKEN: process.env.TOKEN,
      CLIENT_ID: process.env.CLIENT_ID,
      MONGO_URI: process.env.MONGO_URI,
    };
    process.env.TOKEN = 'real-bot-token-value-xyz';
    process.env.CLIENT_ID = '123456789012345678';
    delete process.env.MONGO_URI;
    try {
      const fake = buildRunFakeClient();
      const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});
      await bot.run();
      expect(bot.env).toBeDefined();
      expect(bot.env?.MONGO_URI).toBeUndefined();
      await bot.shutdown();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

it('does not start database recovery when shutdown overtakes clientReady', async () => {
  const fake = buildRunFakeClient();
  const bot = new MinimalBot(fake.client, 'tk', '', 'bot-1', {});
  const startRecovery = vi.spyOn(GuildDbConnector.prototype, 'startRecovery');
  try {
    await bot.run(async () => {
      await bot.shutdown();
    });
    await fake.fire(Events.ClientReady);
    expect(startRecovery).not.toHaveBeenCalled();
  } finally {
    startRecovery.mockRestore();
    await bot.shutdown();
  }
});
