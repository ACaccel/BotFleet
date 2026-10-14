/**
 * `BaseBot.login()` emits one `ops:bot.online` system line per bot on a
 * successful login, naming the bot's Discord `displayName`. This gives
 * operators a per-personality "who am I" marker at startup. The log
 * fires right after the post-login `client.user` null-check, so it is
 * observable without driving the full `ClientReady` flow.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import type * as ConfigModule from '../../../src/core/config';

const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));

// Partial-mock the config barrel: keep `loadEnv` real (setupContainer
// needs it) but swap `createBootstrapLogger` for a fake whose `info` is
// a shared spy so the startup line is observable.
vi.mock('../../../src/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  const make = (): unknown => ({
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => make(),
  });
  return { ...actual, createBootstrapLogger: () => make() };
});

import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config } from '../../../src/bot/index';
import { buildInertClient } from '../../fixtures/discord/client-builder';
import { quietEnvLoadFailure } from './fixtures';

quietEnvLoadFailure();

class MinimalBot extends BaseBot<Config> {}

const buildClient = (user: unknown): Client => {
  return Object.assign(buildInertClient(), {
    user,
    application: { commands: { set: vi.fn(async () => []) } },
    login: async (): Promise<string> => 'ok',
  });
};

describe('BaseBot startup log', () => {
  it('logs an ops:bot.online line with the Discord displayName on successful login', async () => {
    infoSpy.mockClear();
    const client = buildClient({
      id: 'bot-1',
      username: 'archive',
      displayName: 'Server Message Backup',
    });
    const bot = new MinimalBot(client, 'fake-token', '', 'bot-1', {});

    await bot.run();

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('ops:bot.online | Server Message Backup is online.');
  });
});
