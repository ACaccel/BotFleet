import { EventEmitter } from 'node:events';
import type { Client, ClientEvents } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKENS } from '../../../../src/bot/tokens';
import { startMessageDeletionFallback } from '../../../../src/handlers/commands/ban_user/delete-messages-fallback';
import { areAutoRepliesSuppressed } from '../../../../src/infra/discord/suppressed-auto-replies';
import { createAutoReplyPlugin } from '../../../../src/plugins/auto-reply';
import { createLlmAutoReplyPlugin } from '../../../../src/plugins/llm-auto-reply';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { buildPluginContext } from '../../../fixtures/runtime';

const targetId = '516912789369913371';
const build = async () => {
  vi.useFakeTimers();
  // A recording client: the fallback attaches with `prependListener`, which
  // the inert client fixture does not implement.
  const client = new EventEmitter();
  const lookup = vi.fn(async () => ({ ok: true, value: [{ reply: 'matched' }] }));
  const ctx = buildPluginContext({
    services: [[TOKENS.GuildRegistry, { getRepos: () => ({ reply: { findByInput: lookup } }) }]],
  });
  const auto = createAutoReplyPlugin({
    globalLuckyProbability: 1,
    luckyReplies: [{ userId: targetId, probability: 1, reply: 'lucky' }],
  });
  await auto.init?.(ctx);
  const llmReply = vi.fn();
  const llm = createLlmAutoReplyPlugin(
    { enabled: true, probability: 1 },
    { clientId: 'bot', client: { reply: llmReply } },
  );
  const pending: Array<Promise<void> | void> = [];
  // Production plugin listeners are registered before a vote activates the fallback.
  client.on('messageCreate', (message: ClientEvents['messageCreate'][0]) => {
    pending.push(auto.events?.messageCreate?.(ctx, message));
    pending.push(llm.events?.messageCreate?.(ctx, message));
  });
  const start = (durationMs = 1000) =>
    startMessageDeletionFallback({
      client: client as unknown as Client,
      logger: ctx.logger,
      targetMemberId: targetId,
      guildId: 'g1',
      durationMs,
    });
  const message = (content = '2d6', userId = targetId, guildId = 'g1') => {
    const del = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const fetchMessages = vi.fn(async () => new Map());
    const reply = vi.fn(async () => undefined);
    const msg = buildMessage({
      content,
      author: { id: userId, bot: false },
      guild: { id: guildId },
      guildId,
      channelId: 'c1',
      createdTimestamp: Date.now(),
      mentions: { has: () => true },
      channel: { isSendable: () => true, messages: { fetch: fetchMessages }, send },
      reply,
      delete: del,
    });
    return { msg, del, send, fetchMessages, reply };
  };
  const emit = async (sent: ReturnType<typeof message>) => {
    client.emit('messageCreate', sent.msg);
    await Promise.all(pending.splice(0));
  };
  return { client, start, message, emit, lookup, llmReply };
};

afterEach(() => vi.useRealTimers());

describe('ban_user fallback auto-reply suppression', () => {
  it.each(['2d6', '長髮男', '該睡覺了，肥貓跟你說晚安', '<@bot> hello'])(
    'blocks all reply paths before deletion finishes: %s',
    async (content) => {
      const f = await build();
      f.start();
      const sent = f.message(content);
      sent.del.mockImplementation(() => new Promise(() => undefined));
      await f.emit(sent);
      expect(sent.del).toHaveBeenCalledOnce();
      expect(f.lookup).not.toHaveBeenCalled();
      expect(sent.send).not.toHaveBeenCalled();
      expect(sent.reply).not.toHaveBeenCalled();
      expect(sent.fetchMessages).not.toHaveBeenCalled();
      expect(f.llmReply).not.toHaveBeenCalled();
    },
  );

  it('still blocks replies when deletion fails', async () => {
    const f = await build();
    f.start();
    const sent = f.message();
    sent.del.mockRejectedValue(new Error('Missing Permissions'));
    await f.emit(sent);
    expect(sent.send).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
  });

  it('leaves other users and guilds unaffected and resumes at expiry', async () => {
    const f = await build();
    f.start();
    for (const sent of [f.message('2d6', 'other'), f.message('2d6', targetId, 'other')]) {
      await f.emit(sent);
      expect(sent.del).not.toHaveBeenCalled();
      expect(sent.send).toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const sent = f.message();
    await f.emit(sent);
    expect(sent.del).not.toHaveBeenCalled();
    expect(sent.send).toHaveBeenCalled();
    expect(f.client.listenerCount('messageCreate')).toBe(1);
  });

  it('keeps overlapping punishments active until the last window expires', async () => {
    const f = await build();
    f.start(1000);
    f.start(2000);
    await vi.advanceTimersByTimeAsync(1000);
    const sent = f.message();
    await f.emit(sent);
    expect(sent.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await f.emit(f.message());
    expect(f.lookup).toHaveBeenCalled();
  });

  it('uses the deadline even if timer cleanup has not run', async () => {
    const f = await build();
    f.start();
    vi.setSystemTime(Date.now() + 1000);
    const sent = f.message();
    await f.emit(sent);
    expect(areAutoRepliesSuppressed(sent.msg)).toBe(false);
    expect(sent.send).toHaveBeenCalled();
  });
});
