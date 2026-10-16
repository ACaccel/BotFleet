import type { Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOKENS } from '../../../src/bot/tokens';
import { createContainer } from '../../../src/core/ioc';
import { ok } from '../../../src/core/result';
import {
  DEFAULT_RATE_LIMIT,
  parseAiPolicy,
  type AiPolicy,
} from '../../../src/application/ai/policy';
import { LLMService } from '../../../src/infra/llm';
import type { Repos } from '../../../src/persistence/repositories';
import { createLlmChatPlugin } from '../../../src/plugins/llm-chat';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

afterEach(() => vi.restoreAllMocks());

const fixture = async (isAdmin = false, policy: AiPolicy = { rateLimit: DEFAULT_RATE_LIMIT }) => {
  const chat = vi
    .spyOn(LLMService.prototype, 'chat')
    .mockResolvedValue(ok({ content: 'Reply', usage: null }));
  const record = vi.fn(async () => ok(undefined));
  const windowSince = vi.fn(async () => ok({ count: 0 }));
  const repos = {
    aiUsage: { record, windowSince },
    userApiSetting: {
      findByUserId: vi.fn(async () =>
        ok({
          provider: 'xai',
          model: 'stored-model',
          temperature: 0.7,
          system_prompt: 'Be concise',
          web_search: false,
        }),
      ),
    },
  } as unknown as Repos;
  const logger = silentLogger();
  const container = createContainer();
  container.registerSingleton(TOKENS.Env, () => ({}) as never);
  container.registerSingleton(TOKENS.Logger, () => logger);
  container.registerSingleton(TOKENS.GuildRegistry, () => ({
    getRepos: () => repos,
    getChannel: () => undefined,
    getRole: () => undefined,
    listGuildIds: () => ['guild-1'],
  }));
  // One context serves both lifecycles: `registerInstance` is only legal
  // during `init`, which is the only phase that calls it.
  const context = buildPluginContext({
    logger,
    resolve: container.resolve.bind(container),
    registerInstance: (token, instance) => container.registerSingleton(token, () => instance),
  });
  const plugin = createLlmChatPlugin({ clientId: 'bot-1', policy, isAdmin: () => isAdmin });
  await plugin.init?.(context);
  const handler = plugin.events?.messageCreate;
  if (handler === undefined) throw new Error('llm-chat must subscribe to messageCreate');
  let nextReply = 0;
  const message = ({
    content = '<@bot-1> Hello',
    userId = 'member-1',
    mention = true,
    refId,
  }: { content?: string; userId?: string; mention?: boolean; refId?: string } = {}) => {
    const placeholder = { id: `reply-${++nextReply}`, edit: vi.fn(async () => placeholder) };
    const reply = vi.fn(async (_payload: unknown) => placeholder);
    return {
      message: buildMessage({
        author: { id: userId, bot: false },
        guildId: 'guild-1',
        channelId: 'channel-1',
        content,
        reference: refId ? { messageId: refId } : null,
        mentions: { has: () => mention },
        reply,
      }),
      reply,
      placeholder,
    };
  };
  return {
    chat,
    record,
    windowSince,
    message,
    // The handler's parameter type excludes partial group-DM channels, which the stub never models.
    dispatch: (msg: Message) => handler(context, msg as never),
  };
};

const NO_MENTIONS = { parse: [] };
const THINKING = { content: 'replies:llm_chat.thinking', allowedMentions: NO_MENTIONS };
const delivered = (content: string) => ({ content, allowedMentions: NO_MENTIONS });

describe('llm-chat admission', () => {
  it.each(['<@bot-1>', '  <@!bot-1>  '])('does not charge an empty mention %s', async (content) => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const request = message({ content });
    await dispatch(request.message);
    // The user sees nothing, and no quota or provider spend is incurred.
    expect(request.reply).not.toHaveBeenCalled();
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("does not charge someone replying to another member's session", async () => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    record.mockClear();
    windowSince.mockClear();
    chat.mockClear();
    const intruder = message({
      content: 'Continue',
      userId: 'member-2',
      mention: false,
      refId: original.placeholder.id,
    });
    await dispatch(intruder.message);
    expect(intruder.reply).not.toHaveBeenCalled();
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();

    // The intruder's text never entered the owner's conversation.
    await dispatch(
      message({ content: 'Mine', mention: false, refId: original.placeholder.id }).message,
    );
    expect(chat.mock.calls[0]?.[0]).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Mine' },
    ]);
  });

  it('does not charge an empty continuation from the session owner', async () => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    record.mockClear();
    windowSince.mockClear();
    chat.mockClear();
    const blank = message({ content: '  ', mention: false, refId: original.placeholder.id });
    await dispatch(blank.message);
    expect(blank.reply).not.toHaveBeenCalled();
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('opens a session by replying with a placeholder that becomes the answer', async () => {
    const { message, dispatch } = await fixture();
    const request = message();
    await dispatch(request.message);
    expect(request.reply).toHaveBeenCalledExactlyOnceWith(THINKING);
    expect(request.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));
  });

  it("records and delivers an owner's valid continuation", async () => {
    const { message, dispatch, record, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    const followUp = message({
      content: 'Continue',
      mention: false,
      refId: original.placeholder.id,
    });
    await dispatch(followUp.message);

    expect(followUp.reply).toHaveBeenCalledExactlyOnceWith(THINKING);
    expect(followUp.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));
    expect(record).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenLastCalledWith(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Continue' },
      ],
      expect.objectContaining({ model: 'stored-model' }),
    );
  });

  it('refuses overlapping calls and releases the slot after delivery', async () => {
    const { message, dispatch, record, chat } = await fixture();
    let finish!: () => void;
    chat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok({ content: 'Reply', usage: null }));
        }),
    );
    const first = message();
    const pending = dispatch(first.message);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const overlapping = message();
    await dispatch(overlapping.message);
    expect(overlapping.reply).toHaveBeenCalledExactlyOnceWith(delivered('replies:llm_chat.busy'));
    expect(record).toHaveBeenCalledOnce();
    expect(first.placeholder.edit).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(first.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));

    const retry = message();
    await dispatch(retry.message);
    expect(retry.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));
    expect(chat).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('releases the slot when sending the placeholder fails', async () => {
    const { message, dispatch, record, chat } = await fixture();
    const failed = message();
    failed.reply.mockRejectedValueOnce(new Error('Discord unavailable'));
    await expect(dispatch(failed.message)).rejects.toThrow('Discord unavailable');
    const retry = message();
    await dispatch(retry.message);
    expect(retry.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));
    expect(chat).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('preserves model and quota admin exemption %s', async (isAdmin) => {
    const policy = parseAiPolicy({
      ai: {
        models: {
          default: { provider: 'xai', model: 'allowed-model' },
          allowed: { xai: ['allowed-model'] },
        },
      },
    });
    const { message, dispatch, record, windowSince, chat } = await fixture(isAdmin, policy);
    const request = message();
    await dispatch(request.message);
    // Both audiences get the answer; what differs is the model and the quota.
    expect(request.placeholder.edit).toHaveBeenCalledExactlyOnceWith(delivered('Reply'));
    expect(record).toHaveBeenCalledTimes(isAdmin ? 0 : 1);
    expect(windowSince).toHaveBeenCalledTimes(isAdmin ? 0 : 2);
    expect(chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      expect.objectContaining({ model: isAdmin ? 'stored-model' : 'allowed-model' }),
    );
  });
});
