import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoReplyPlugin } from '../../../src/plugins/auto-reply';
import { ReplyCooldown } from '../../../src/plugins/auto-reply/cooldown';
import {
  defaultGuildSettings,
  FEATURES,
  type GuildSettingsRuntime,
  type GuildSettingsSnapshot,
} from '../../../src/core/guild-settings';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { TOKENS } from '../../../src/bot/tokens';
import { ok } from '../../../src/core/result';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext } from '../../fixtures/runtime';

const guildA = '111111111111111111';
const guildB = '222222222222222222';
const userId = '333333333333333333';
const snapshot = (guildId = guildA): GuildSettingsSnapshot => {
  const settings = defaultGuildSettings({
    features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
      (typeof FEATURES)[number],
      boolean
    >,
    socialProviders: ['twitter'],
    maxRandomProbability: 1,
    minCooldownSeconds: 0,
    maxPreviewUrls: 5,
  });
  settings.autoReply.probability = 0;
  settings.autoReply.cooldownSeconds = 0;
  return { botId: 'bot', guildId, revision: 1, settings, audit: [], lastOperationId: 'seed' };
};
const runtime = (snapshots: GuildSettingsSnapshot[], allowed = true): GuildSettingsRuntime => ({
  get: (guildId) => snapshots.find((value) => value.guildId === guildId),
  isEnabled: vi.fn(
    (_guildId, _feature, _channelId, ancestors) => allowed && !ancestors?.includes('excluded'),
  ),
});
const setup = async (settings: GuildSettingsRuntime, raw: unknown = {}) => {
  const find = vi.fn(async (_guildId: string, input: string) =>
    ok(input === 'hello' ? [{ reply: 'stored' }] : []),
  );
  const registry = {
    getRepos: (guildId: string) => ({
      reply: { findByInput: (input: string) => find(guildId, input) },
    }),
  } as unknown as GuildRegistry;
  const ctx = buildPluginContext({ services: [[TOKENS.GuildRegistry, registry]] });
  const plugin = createAutoReplyPlugin(raw, settings);
  await plugin.init?.(ctx);
  const deliver = async (
    content: string,
    guildId = guildA,
    fields: Record<string, unknown> = {},
  ) => {
    const send = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);
    const message = buildMessage({
      content,
      guildId,
      author: { id: userId, bot: false },
      channel: { isSendable: () => true, send },
      reply,
      ...fields,
    });
    const handler = plugin.events!.messageCreate!;
    await handler(ctx, message as Parameters<typeof handler>[1]);
    return { send, reply };
  };
  return { deliver, find, plugin, ctx };
};

afterEach(() => vi.useRealTimers());
describe('guild-scoped automatic replies', () => {
  it('fails closed on unknown guilds and disables every branch, including bot goodnight', async () => {
    const { deliver, find } = await setup(runtime([snapshot()], false), {
      globalLuckyProbability: 1,
    });
    for (const content of ['hello', '1d6', '長髮男', '該睡覺了，肥貓跟你說晚安']) {
      const result = await deliver(content);
      expect(result.send).not.toHaveBeenCalled();
      expect(result.reply).not.toHaveBeenCalled();
    }
    const bot = await deliver('該睡覺了，肥貓跟你說晚安', guildA, {
      author: { id: userId, bot: true },
    });
    expect(bot.reply).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    const missing = await setup(runtime([]));
    expect((await missing.deliver('hello')).send).not.toHaveBeenCalled();
  });

  it('uses each guild preference and forwards thread/category ancestry', async () => {
    const a = snapshot();
    a.settings.autoReply.keywords = false;
    const port = runtime([a, snapshot(guildB)]);
    const { deliver } = await setup(port);
    expect((await deliver('hello')).send).not.toHaveBeenCalled();
    expect((await deliver('hello', guildB)).send).toHaveBeenCalled();
    const result = await deliver('hello', guildB, {
      channel: { isSendable: () => true, parentId: 'parent', send: vi.fn() },
      guild: { channels: { cache: { get: () => ({ parentId: 'excluded' }) } } },
    });
    expect(result.send).not.toHaveBeenCalled();
    expect(port.isEnabled).toHaveBeenLastCalledWith(
      guildB,
      'auto_reply',
      'c1',
      expect.arrayContaining(['parent', 'excluded']),
    );
  });

  it('honors every granular switch even when the master gate allows delivery', async () => {
    const value = snapshot();
    value.settings.autoReply = {
      keywords: false,
      random: false,
      dice: false,
      reactions: false,
      probability: 1,
      cooldownSeconds: 0,
    };
    const { deliver, find } = await setup(runtime([value]));
    for (const content of ['hello', '1d6', '長髮男', '該睡覺了，肥貓跟你說晚安']) {
      const result = await deliver(content);
      expect(result.send).not.toHaveBeenCalled();
      expect(result.reply).not.toHaveBeenCalled();
    }
    expect(find).not.toHaveBeenCalled();
  });

  it('uses the effective guild random probability instead of the legacy default', async () => {
    const a = snapshot();
    const b = snapshot(guildB);
    a.settings.autoReply.keywords = b.settings.autoReply.keywords = false;
    b.settings.autoReply.probability = 1;
    const registry = {
      getRepos: () => ({ reply: { findByInput: async () => ok([{ reply: 'random' }]) } }),
    } as unknown as GuildRegistry;
    const ctx = buildPluginContext({ services: [[TOKENS.GuildRegistry, registry]] });
    const plugin = createAutoReplyPlugin({ globalLuckyProbability: 0 }, runtime([a, b]));
    await plugin.init?.(ctx);
    const send = vi.fn(async () => undefined);
    const handler = plugin.events!.messageCreate!;
    for (const guildId of [guildA, guildB]) {
      await handler(
        ctx,
        buildMessage({
          guildId,
          content: 'unmatched',
          channel: { isSendable: () => true, send },
        }) as Parameters<typeof handler>[1],
      );
    }
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: 'random',
      allowedMentions: { parse: [] },
    });
  });

  it('clears ephemeral cooldown state on shutdown without changing guild preferences', async () => {
    const value = snapshot();
    value.settings.autoReply.cooldownSeconds = 5;
    const { deliver, plugin, ctx } = await setup(runtime([value]));
    expect((await deliver('hello')).send).toHaveBeenCalledOnce();
    expect((await deliver('hello')).send).not.toHaveBeenCalled();
    await plugin.onShutdown?.(ctx);
    await plugin.init?.(ctx);
    expect((await deliver('hello')).send).toHaveBeenCalledOnce();
    expect(value.settings.autoReply.cooldownSeconds).toBe(5);
  });

  it('does not consume cooldown for unmatched messages and isolates guilds/channels', async () => {
    vi.useFakeTimers();
    const a = snapshot();
    const b = snapshot(guildB);
    a.settings.autoReply.cooldownSeconds = b.settings.autoReply.cooldownSeconds = 5;
    const { deliver } = await setup(runtime([a, b]));
    await deliver('unmatched');
    expect((await deliver('hello')).send).toHaveBeenCalledOnce();
    expect((await deliver('hello')).send).not.toHaveBeenCalled();
    expect((await deliver('hello', guildB)).send).toHaveBeenCalledOnce();
    expect((await deliver('hello', guildA, { channelId: 'other' })).send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await deliver('hello')).send).toHaveBeenCalledOnce();
  });

  it('reserves before async sends so concurrent matched messages produce only one reply', async () => {
    const a = snapshot();
    a.settings.autoReply.cooldownSeconds = 5;
    const { deliver } = await setup(runtime([a]));
    const results = await Promise.all([deliver('hello'), deliver('hello')]);
    expect(results.reduce((count, result) => count + result.send.mock.calls.length, 0)).toBe(1);
  });

  it('bounds active reservations without evicting channels that are cooling down', () => {
    vi.useFakeTimers();
    const cooldown = new ReplyCooldown();
    for (let index = 0; index < 4096; index++) cooldown.reserve(String(index), 5000)?.();
    expect(cooldown.reserve('overflow', 5000)).toBeUndefined();
    expect(cooldown.reserve('0', 5000)).toBeUndefined();
    vi.advanceTimersByTime(5000);
    expect(cooldown.reserve('overflow', 5000)).toBeTypeOf('function');
    cooldown.clear();
    expect(cooldown.reserve('overflow', 5000)).toBeTypeOf('function');
  });
});
