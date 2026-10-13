/**
 * Characterisation + behaviour test for the channel-logging middleware.
 *
 * Pins the load-bearing contract the suppression path upholds via
 * {@link PermissionRankPolicy}: a command in a channel above
 * the `channel_logging` rank ceiling is kept OUT of the debug feed
 * (`sendChannelLog` not called), but the durable guild audit-log line
 * (`logGuildEvent`) ALWAYS fires — even for a suppressed channel and even
 * when the dispatched handler threw (the try/finally invariant).
 */
/* eslint-disable import/first */
import * as path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Colors } from 'discord.js';

// `middlewares.ts` imports the interaction dispatchers (`@cmd` etc.), whose
// barrels transitively load the generated handler registry. Stub them so the
// test does not boot the entire command surface just to exercise logging.
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

// Mock the two log sinks the middleware drives; keep `ancestorChannelIdsOf`
// real so the parent → category ancestry walk is exercised, not stubbed.
vi.mock('@core/logger', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logGuildEvent: vi.fn(),
}));
vi.mock('../../../src/infra/discord', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  sendChannelLog: vi.fn(),
}));

import { logGuildEvent } from '@core/logger';
import { sendChannelLog } from '../../../src/infra/discord';
import { createChannelLoggingMiddleware } from '../../../src/bot/middlewares';
import { createPermissionRankPolicy } from '../../../src/core/plugin';
import { createLogger } from '../../../src/core/logger';
import { createDefaultTranslator, type Translator } from '../../../src/core/i18n';
import type { BaseBot } from '../../../src/bot/index';
import type { InteractionContext } from '../../../src/core/plugin';

const silent = createLogger({ level: 'silent', pretty: false });
const createdTimestamp = Date.UTC(2026, 9, 13, 6, 0, 0);
let translator: Translator;

const fakeBot = (botTranslator: Translator | undefined = translator): BaseBot =>
  ({
    logger: silent,
    translator: botTranslator,
    getGuildInfo: () => ({ channels: { debug: { id: 'debug-channel' } } }),
  }) as unknown as BaseBot;

const interactionCtx = (channelId: string): InteractionContext =>
  ({
    interaction: {
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      channelId,
      guildId: 'g1',
      channel: { parentId: null },
      commandName: 'ping',
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => null,
      },
      createdTimestamp,
      user: { id: 'u1', displayName: 'User' },
      guild: { id: 'g1', name: 'Guild', channels: { cache: { get: () => ({ name: channelId }) } } },
    },
  }) as unknown as InteractionContext;

const run = async (channelId: string): Promise<void> => {
  const policy = createPermissionRankPolicy({ g1: { channels: { private: 1 } } });
  const middleware = createChannelLoggingMiddleware(fakeBot(), { policy });
  await middleware.run(interactionCtx(channelId), async () => undefined);
};

describe('channel-logging middleware', () => {
  beforeAll(async () => {
    translator = await createDefaultTranslator({
      localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a command in a rank-0 channel to the debug feed AND the guild audit log', async () => {
    await run('public');
    expect(sendChannelLog).toHaveBeenCalledTimes(1);
    const [logger, channel, embed, content] = vi.mocked(sendChannelLog).mock.calls[0]!;
    expect(logger).toBe(silent);
    expect(channel).toEqual({ id: 'debug-channel' });
    expect(content).toBeUndefined();
    expect(embed?.toJSON()).toEqual({
      color: Colors.Blurple,
      title: '/ping',
      fields: [
        { name: '使用者', value: '<@u1>', inline: true },
        { name: '頻道', value: '<#public>', inline: true },
      ],
      footer: { text: '執行時間' },
      timestamp: new Date(createdTimestamp).toISOString(),
    });
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
    expect(logGuildEvent).toHaveBeenCalledWith(
      silent,
      'g1',
      'interaction_create',
      { command: '/ping', user: 'User', channel: 'public' },
      'Guild',
    );
  });

  it.each([
    { group: null, subcommand: 'status', title: '/archive status' },
    { group: 'whitelist', subcommand: 'add', title: '/ai whitelist add' },
  ])('includes the complete slash-command path: $title', async ({ group, subcommand, title }) => {
    const policy = createPermissionRankPolicy({});
    const ctx = interactionCtx('public');
    Object.assign(ctx.interaction, {
      commandName: group === null ? 'archive' : 'ai',
      options: {
        getSubcommandGroup: () => group,
        getSubcommand: () => subcommand,
        data: [{ name: 'private_value', value: 'must-not-be-logged' }],
      },
    });
    await createChannelLoggingMiddleware(fakeBot(), { policy }).run(ctx, async () => undefined);
    const embed = vi.mocked(sendChannelLog).mock.calls[0]![2]?.toJSON();
    expect(embed?.title).toBe(title);
    expect(JSON.stringify(embed)).not.toContain('must-not-be-logged');
  });

  it.each([
    { locale: 'zh-TW', user: '使用者', channel: '頻道', time: '執行時間' },
    { locale: 'en', user: 'User', channel: 'Channel', time: 'Executed at' },
  ] as const)('uses the bot display language: $locale', async ({ locale, user, channel, time }) => {
    const localized = await createDefaultTranslator({
      localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
      fallbackLocale: locale,
    });
    const policy = createPermissionRankPolicy({});
    await createChannelLoggingMiddleware(fakeBot(localized), { policy }).run(
      interactionCtx('public'),
      async () => undefined,
    );
    const embed = vi.mocked(sendChannelLog).mock.calls[0]![2]?.toJSON();
    expect(embed?.fields?.map((field) => field.name)).toEqual([user, channel]);
    expect(embed?.footer?.text).toBe(time);
  });

  it('logs context-menu commands without slash syntax or slash-command option access', async () => {
    const policy = createPermissionRankPolicy({});
    const ctx = interactionCtx('public');
    Object.assign(ctx.interaction, {
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'Get avatar',
      options: undefined,
    });
    await createChannelLoggingMiddleware(fakeBot(), { policy }).run(ctx, async () => undefined);
    expect(vi.mocked(sendChannelLog).mock.calls[0]![2]?.toJSON().title).toBe('Get avatar');
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('does not log non-command interactions', async () => {
    const policy = createPermissionRankPolicy({});
    const ctx = interactionCtx('public');
    Object.assign(ctx.interaction, {
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
    });
    await createChannelLoggingMiddleware(fakeBot(), { policy }).run(ctx, async () => undefined);
    expect(sendChannelLog).not.toHaveBeenCalled();
    expect(logGuildEvent).not.toHaveBeenCalled();
  });

  it('does not send guild-channel command logs for direct messages', async () => {
    const policy = createPermissionRankPolicy({});
    const ctx = interactionCtx('dm');
    Object.assign(ctx.interaction, { guildId: null, guild: null });
    await createChannelLoggingMiddleware(fakeBot(), { policy }).run(ctx, async () => undefined);
    expect(sendChannelLog).not.toHaveBeenCalled();
    expect(logGuildEvent).not.toHaveBeenCalled();
  });

  it('suppresses the debug feed for a channel above the channel_logging ceiling, but still writes the audit log', async () => {
    await run('private');
    expect(sendChannelLog).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('suppresses the debug feed for a thread nested under a private category (full ancestry)', async () => {
    const policy = createPermissionRankPolicy({ g1: { channels: { cat: 1 } } });
    const middleware = createChannelLoggingMiddleware(fakeBot(), { policy });
    // command in thread 'th' → channel 'ch-cat' (unlisted) → category 'cat' (rank 1);
    // the cache resolves the intermediate channel so the walk reaches the category.
    const ctx = {
      interaction: {
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        channelId: 'th',
        guildId: 'g1',
        channel: { parentId: 'ch-cat' },
        commandName: 'ping',
        user: { displayName: 'User' },
        guild: {
          id: 'g1',
          name: 'Guild',
          channels: {
            cache: { get: (id: string) => (id === 'ch-cat' ? { parentId: 'cat' } : { name: id }) },
          },
        },
      },
    } as unknown as InteractionContext;
    await middleware.run(ctx, async () => undefined);
    expect(sendChannelLog).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('still writes the guild audit log when the dispatched handler throws, then re-throws (try/finally)', async () => {
    const policy = createPermissionRankPolicy({ g1: { channels: { private: 1 } } });
    const middleware = createChannelLoggingMiddleware(fakeBot(), { policy });
    await expect(
      middleware.run(interactionCtx('public'), async () => {
        throw new Error('dispatch failed');
      }),
    ).rejects.toThrow('dispatch failed');
    // The audit line must land even though dispatch crashed — it is in `finally`.
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
    expect(sendChannelLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChannelLog).mock.calls[0]![2]?.toJSON().title).toBe('/ping');
  });
});
