import { describe, expect, it, vi } from 'vitest';

import { createAutoReplyPlugin } from '../../../src/plugins/auto-reply';
import { parseAutoReplyConfig } from '../../../src/plugins/auto-reply/config';
import { TOKENS } from '../../../src/bot/tokens';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { buildPluginContext } from '../../fixtures/runtime';

describe('parseAutoReplyConfig', () => {
  it('defaults to the 0.5% global random probability', () => {
    expect(parseAutoReplyConfig(undefined)).toEqual({ globalLuckyProbability: 0.005 });
  });

  it.each([0, 0.02, 1])('accepts a global probability of %s', (probability) => {
    expect(parseAutoReplyConfig({ globalLuckyProbability: probability })).toEqual({
      globalLuckyProbability: probability,
    });
  });

  it.each([-1, 5])('rejects a probability outside 0–1: %s', (probability) => {
    expect(() => parseAutoReplyConfig({ globalLuckyProbability: probability })).toThrow();
  });

  it('rejects retired targeted replies and unknown keys', () => {
    expect(() => parseAutoReplyConfig({ luckyReplies: [] })).toThrow();
    expect(() => parseAutoReplyConfig({ typoedKey: true })).toThrow();
  });
});

/** Minimal event context: only the guild registry is resolved. */
const buildCtx = () => {
  const registry: GuildRegistry = {
    getRepos: () => undefined,
    getChannel: () => undefined,
    getRole: () => undefined,
    listGuildIds: () => [],
  };
  return buildPluginContext({ services: [[TOKENS.GuildRegistry, registry]] });
};

const messageFrom = (authorId: string, send: ReturnType<typeof vi.fn>) =>
  ({
    content: 'anything',
    guildId: 'g1',
    author: { id: authorId, bot: false },
    channel: { isSendable: () => true, send },
    reply: vi.fn(),
  }) as never;

describe('createAutoReplyPlugin dependency wiring', () => {
  it('refuses to run an event that somehow precedes init', async () => {
    // The host never dispatches to a plugin whose init did not run;
    // raising keeps a mis-wired plugin from looking alive and idle.
    const plugin = createAutoReplyPlugin();
    const send = vi.fn(async () => undefined);
    await expect(
      plugin.events?.messageCreate?.(buildCtx(), messageFrom('u1', send)),
    ).rejects.toThrow(/dispatched before init/);
    expect(send).not.toHaveBeenCalled();
  });
});
