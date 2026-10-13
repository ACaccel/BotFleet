import type { ClientEvents } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOKENS } from '../../../src/bot/tokens';
import { createContainer } from '../../../src/core/ioc';
import { createLogger } from '../../../src/core/logger';
import type { PluginEventContext, PluginInitContext } from '../../../src/core/plugin';
import { ok } from '../../../src/core/result';
import { systemClock } from '../../../src/core/time';
import {
  DEFAULT_RATE_LIMIT,
  parseAiPolicy,
  type AiPolicy,
} from '../../../src/application/ai/policy';
import { LLMService } from '../../../src/infra/llm';
import type { Repos } from '../../../src/persistence/repositories';
import { createLlmChatPlugin } from '../../../src/plugins/llm-chat';

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
  const logger = createLogger({ level: 'silent', pretty: false });
  const container = createContainer();
  container.registerSingleton(TOKENS.Env, () => ({}) as never);
  container.registerSingleton(TOKENS.Logger, () => logger);
  container.registerSingleton(TOKENS.GuildRegistry, () => ({
    getRepos: () => repos,
    getChannel: () => undefined,
    getRole: () => undefined,
    listGuildIds: () => ['guild-1'],
  }));
  const services = {
    logger,
    translator: { t: (key: string) => key } as PluginEventContext['translator'],
    clock: systemClock,
    resolve: container.resolve.bind(container),
  };
  const plugin = createLlmChatPlugin({ clientId: 'bot-1', policy, isAdmin: () => isAdmin });
  const initContext: PluginInitContext = {
    ...services,
    registerInstance: (token, instance) => container.registerSingleton(token, () => instance),
  };
  await plugin.init?.(initContext);
  const handler = plugin.events?.messageCreate;
  if (handler === undefined) throw new Error('llm-chat must subscribe to messageCreate');
  const eventContext: PluginEventContext = { ...services, eventName: 'messageCreate' };
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
      message: {
        author: { id: userId, bot: false },
        guildId: 'guild-1',
        channelId: 'channel-1',
        content,
        reference: refId ? { messageId: refId } : null,
        mentions: { has: () => mention },
        reply,
      } as unknown as ClientEvents['messageCreate'][0],
      reply,
      placeholder,
    };
  };
  return {
    chat,
    record,
    windowSince,
    message,
    dispatch: (msg: ClientEvents['messageCreate'][0]) => handler(eventContext, msg),
  };
};

describe('llm-chat admission', () => {
  it.each(['<@bot-1>', '  <@!bot-1>  '])('does not charge an empty mention %s', async (content) => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const request = message({ content });
    await dispatch(request.message);
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
  });

  it("does not charge someone replying to another member's session", async () => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    record.mockClear();
    windowSince.mockClear();
    chat.mockClear();
    const request = message({
      content: 'Continue',
      userId: 'member-2',
      mention: false,
      refId: original.placeholder.id,
    });
    await dispatch(request.message);
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
  });

  it('does not charge an empty continuation from the session owner', async () => {
    const { message, dispatch, record, windowSince, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    record.mockClear();
    windowSince.mockClear();
    chat.mockClear();
    await dispatch(
      message({ content: '  ', mention: false, refId: original.placeholder.id }).message,
    );
    expect(windowSince).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("records and delivers an owner's valid continuation", async () => {
    const { message, dispatch, record, chat } = await fixture();
    const original = message();
    await dispatch(original.message);
    await dispatch(
      message({ content: 'Continue', mention: false, refId: original.placeholder.id }).message,
    );
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
    const pending = dispatch(message().message);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const overlapping = message();
    await dispatch(overlapping.message);
    expect(overlapping.reply).toHaveBeenCalledWith({
      content: 'replies:llm_chat.busy',
      allowedMentions: { parse: [] },
    });
    expect(record).toHaveBeenCalledOnce();
    finish();
    await pending;
    await dispatch(message().message);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('releases the slot when sending the placeholder fails', async () => {
    const { message, dispatch, record, chat } = await fixture();
    const failed = message();
    failed.reply.mockRejectedValueOnce(new Error('Discord unavailable'));
    await expect(dispatch(failed.message)).rejects.toThrow('Discord unavailable');
    await dispatch(message().message);
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
    await dispatch(message().message);
    expect(record).toHaveBeenCalledTimes(isAdmin ? 0 : 1);
    expect(windowSince).toHaveBeenCalledTimes(isAdmin ? 0 : 2);
    expect(chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      expect.objectContaining({ model: isAdmin ? 'stored-model' : 'allowed-model' }),
    );
  });
});
