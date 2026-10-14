/**
 * Integration tests for `BaseBot.run()` login failure handling.
 * `run()` aborts with a `ConfigurationError` when the Discord login
 * dance fails (the underlying `client.login` rejects, or it resolves
 * but no `user` was produced) rather than continuing into
 * `host.startAll()` / guild Mongo fan-out with a half-attached client.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config } from '../../../src/bot/index';
import { ConfigurationError } from '../../../src/core/errors';

interface FakeBits {
  readonly client: Client;
  readonly attachSpy: ReturnType<typeof vi.fn>;
}

const buildFake = (init: {
  login: (token: string) => Promise<unknown>;
  user: unknown;
}): FakeBits => {
  const attachSpy = vi.fn();
  const client = {
    user: init.user,
    guilds: { cache: new Map() },
    channels: { cache: new Map() },
    application: { commands: { set: vi.fn(async () => []) } },
    login: init.login,
    destroy: () => {},
    on: () => client,
    once: () => client,
    off: () => client,
  } as unknown as Client;
  return { client, attachSpy };
};

class MinimalBot extends BaseBot<Config> {}

describe('BaseBot.run() — login failure', () => {
  it('rejects with ConfigurationError(BOT_LOGIN_FAILED) when client.login throws', async () => {
    const fake = buildFake({
      login: async () => {
        throw new Error('invalid token');
      },
      user: { id: 'bot-1', username: 'Botty' },
    });
    const bot = new MinimalBot(fake.client, 'fake-token', '', 'bot-1', {});

    const rejection = await bot.run().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(ConfigurationError);
    expect(rejection).toMatchObject({
      code: 'BOT_LOGIN_FAILED',
      messageKey: 'errors:bot.login_failed',
    });
    // run() must not have reached host.startAll() / ClientReady: both
    // run after login() inside run(). We assert the public symptom —
    // `guildInfo` (populated in ClientReady) stays at the default
    // empty map.
    expect(bot.getAllGuildInfo().size).toBe(0);
  });

  it('rejects with ConfigurationError(BOT_LOGIN_NO_USER) when client.user is missing post-login', async () => {
    const fake = buildFake({
      login: async () => 'ok',
      user: null,
    });
    const bot = new MinimalBot(fake.client, 'fake-token', '', 'bot-1', {});

    const rejection = await bot.run().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(ConfigurationError);
    expect(rejection).toMatchObject({
      code: 'BOT_LOGIN_NO_USER',
      messageKey: 'errors:bot.login_no_user',
    });
    expect(bot.getAllGuildInfo().size).toBe(0);
  });
});
