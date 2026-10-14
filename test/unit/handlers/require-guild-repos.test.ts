/**
 * Unit coverage for `requireGuildRepos` and the non-replying
 * `lookupGuildRepos` it is built on.
 *
 * The disabled-guild guard reads `ConnectionManager.isDisabled` straight
 * off `BaseBot.connectionManager`, and the `traceId` surfaced to the user
 * must be the one the manager stamped.
 *
 * The two are asserted separately on purpose: the split exists so that
 * a caller which cannot reply — an autocomplete interaction — still
 * resolves the same bundle, and a lookup that quietly answered
 * differently from the replying path would be invisible until a
 * suggestion list went empty for no stated reason.
 */
import { describe, expect, it } from 'vitest';

import type { BaseBot } from '../../../src/bot/index';
import { lookupGuildRepos, requireGuildRepos } from '../../../src/handlers/require-guild-repos';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

/** An un-acknowledged interaction; `undefined` places it outside a guild. */
const stubInteraction = (guildId: string | undefined) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({ guildId: guildId ?? null, sink });
  return { interaction, replies: sink.replies };
};

interface StubBotInput {
  readonly disabled?: { guildId: string; traceId: string };
  readonly repos?: Readonly<Record<string, unknown>>;
}

/** A `BaseBot`-shaped stub exposing only what `requireGuildRepos` reads. */
const stubBot = (input: StubBotInput = {}): BaseBot => {
  const disabledMap = new Map<string, { traceId: string; error: Error }>();
  if (input.disabled) {
    disabledMap.set(input.disabled.guildId, {
      traceId: input.disabled.traceId,
      error: new Error('boot failure'),
    });
  }
  return buildFakeBot({
    clientId: 'bot-1',
    translator: echoTranslatorWithParams('|'),
    connectionManager: {
      isDisabled: (guildId: string) => disabledMap.get(guildId),
    },
    getRepos: (guildId: string) => (guildId === 'g-1' ? input.repos : undefined),
  }).bot;
};

describe('requireGuildRepos — reads ConnectionManager.isDisabled', () => {
  it('replies guild_only and returns null outside a guild', async () => {
    const { interaction, replies } = stubInteraction(undefined);
    const result = await requireGuildRepos(stubBot(), interaction);
    expect(result).toBeNull();
    expect(replies[0]?.content).toBe('errors:command.guild_only');
  });

  it('replies guild_disabled with the manager traceId for a disabled guild', async () => {
    const { interaction, replies } = stubInteraction('g-1');
    const bot = stubBot({ disabled: { guildId: 'g-1', traceId: '7f3a2c' } });
    const result = await requireGuildRepos(bot, interaction);
    expect(result).toBeNull();
    expect(replies[0]?.content).toBe('errors:db.guild_disabled|{"traceId":"7f3a2c"}');
  });

  it('replies not_found when the guild has no repos bundle', async () => {
    const { interaction, replies } = stubInteraction('g-1');
    const result = await requireGuildRepos(stubBot(), interaction);
    expect(result).toBeNull();
    expect(replies[0]?.content).toBe('errors:db.not_found');
  });

  it('returns the Repos bundle for a healthy guild', async () => {
    const { interaction, replies } = stubInteraction('g-1');
    const repos = { reply: {} };
    const result = await requireGuildRepos(stubBot({ repos }), interaction);
    expect(result).toBe(repos);
    expect(replies).toHaveLength(0);
  });

  it('treats an absent ConnectionManager as "not disabled"', async () => {
    const { interaction, replies } = stubInteraction('g-1');
    const repos = { reply: {} };
    const { bot } = buildFakeBot({
      clientId: 'bot-1',
      translator: echoTranslatorWithParams('|'),
      connectionManager: undefined,
      getRepos: (guildId: string) => (guildId === 'g-1' ? repos : undefined),
    });
    const result = await requireGuildRepos(bot, interaction);
    expect(result).toBe(repos);
    expect(replies).toHaveLength(0);
  });
});

describe('lookupGuildRepos — the same resolution, without a reply', () => {
  it('reports the bundle for a healthy guild', () => {
    const repos = { reply: {} };
    const lookup = lookupGuildRepos(stubBot({ repos }), 'g-1');
    expect(lookup).toEqual({ kind: 'ready', repos });
  });

  it('carries the guild_only copy for an absent guild id, without throwing', () => {
    // The autocomplete path has no interaction to reply to, so the
    // failure has to come back as a value.
    expect(lookupGuildRepos(stubBot(), undefined)).toEqual({
      kind: 'unavailable',
      key: 'errors:command.guild_only',
    });
  });

  it('carries the disabled-guild copy and the manager traceId', () => {
    const bot = stubBot({ disabled: { guildId: 'g-1', traceId: '7f3a2c' } });
    expect(lookupGuildRepos(bot, 'g-1')).toEqual({
      kind: 'unavailable',
      key: 'errors:db.guild_disabled',
      params: { traceId: '7f3a2c' },
    });
  });

  it('carries the not_found copy when the guild has no repos', () => {
    expect(lookupGuildRepos(stubBot(), 'g-2')).toEqual({
      kind: 'unavailable',
      key: 'errors:db.not_found',
    });
  });
});
