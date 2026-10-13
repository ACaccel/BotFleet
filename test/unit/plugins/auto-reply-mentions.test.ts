/**
 * Stored auto-replies are written by any member through `/reply add`,
 * so the plugin must never let one turn into a ping.
 */
import { describe, expect, it, vi } from 'vitest';

import { createAutoReplyPlugin } from '../../../src/plugins/auto-reply';
import { createLogger } from '../../../src/core/logger';
import { ok } from '../../../src/core/result/result';
import { TOKENS } from '../../../src/bot/tokens';
import type { Plugin, PluginEventContext, PluginInitContext } from '../../../src/core/plugin';
import type { GuildRegistry } from '../../../src/bot/guild-registry';

const silent = createLogger({ level: 'silent', pretty: false });
const PINGING_REPLY = '@everyone <@&123456789012345678> <@123456789012345678>';

const buildCtx = (findByInput: (input: string) => unknown): PluginEventContext => {
  const registry = {
    getRepos: () => ({ reply: { findByInput: async (input: string) => findByInput(input) } }),
    getChannel: () => undefined,
    getRole: () => undefined,
    listGuildIds: () => [],
  } as unknown as GuildRegistry;
  return {
    logger: silent,
    translator: { t: (key: string) => key },
    clock: { now: () => 0, nowDate: () => new Date(0) },
    resolve: ((token: unknown) =>
      token === TOKENS.GuildRegistry ? registry : undefined) as PluginEventContext['resolve'],
  } as unknown as PluginEventContext;
};

const deliver = async (
  plugin: ReturnType<typeof createAutoReplyPlugin>,
  ctx: PluginEventContext,
  message: Parameters<NonNullable<NonNullable<Plugin['events']>['messageCreate']>>[1],
): Promise<void> => {
  await plugin.init?.(ctx as unknown as PluginInitContext);
  await plugin.events?.messageCreate?.(ctx, message);
};

const message = (content: string, send: ReturnType<typeof vi.fn>) =>
  ({
    content,
    guildId: 'g1',
    author: { id: 'u1', bot: false },
    channel: { isSendable: () => true, send },
    reply: vi.fn(),
  }) as never;

describe('auto-reply mention safety', () => {
  it('sends a keyword reply with every mention disabled', async () => {
    const send = vi.fn(async () => undefined);
    const ctx = buildCtx((input) => ok(input === 'hello' ? [{ reply: PINGING_REPLY }] : []));
    const plugin = createAutoReplyPlugin({ luckyReplies: [], globalLuckyProbability: 0 });

    await deliver(plugin, ctx, message('hello', send));

    expect(send).toHaveBeenCalledWith({ content: PINGING_REPLY, allowedMentions: { parse: [] } });
  });

  it('sends a random [*] reply with every mention disabled', async () => {
    const send = vi.fn(async () => undefined);
    const ctx = buildCtx((input) => ok(input === '[*]' ? [{ reply: PINGING_REPLY }] : []));
    const plugin = createAutoReplyPlugin({ luckyReplies: [], globalLuckyProbability: 1 });

    await deliver(plugin, ctx, message('unmatched', send));

    expect(send).toHaveBeenCalledWith({ content: PINGING_REPLY, allowedMentions: { parse: [] } });
  });
});
