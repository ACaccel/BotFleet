/**
 * Unit tests for the LLM auto-reply plugin:
 *   - pure helpers (`buildTranscript`, `isWithinWindow`);
 *   - the bot-mention trigger helpers (`mentionsBot`, `stripBotMention`);
 *   - the orchestrator's fetch -> window -> transcript -> reply pipeline
 *     with an injected fake client (no network);
 *   - the plugin's guard + probability-gate ordering (the dice are rolled
 *     before any fetch), and the @-mention deterministic-trigger path.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Message } from 'discord.js';
import axios from 'axios';

import { createLlmAutoReplyPlugin } from '../../../src/plugins/llm-auto-reply/plugin';
import {
  buildTranscript,
  isWithinWindow,
  type TranscriptMessage,
} from '../../../src/plugins/llm-auto-reply/internal/transcript';
import {
  runLlmAutoReply,
  type RunLlmAutoReplyDeps,
} from '../../../src/plugins/llm-auto-reply/internal/orchestrator';
import { mentionsBot, stripBotMention } from '../../../src/plugins/llm-auto-reply/internal/trigger';
import { ReplyCooldown } from '../../../src/plugins/llm-auto-reply/internal/cooldown';
import { InFlightChannels } from '../../../src/plugins/llm-auto-reply/internal/in-flight';
import {
  clampReply,
  MAX_DISCORD_MESSAGE_LENGTH,
} from '../../../src/plugins/llm-auto-reply/internal/reply';
import { ok, err } from '../../../src/core/result';
import { ExternalServiceError } from '../../../src/core/errors';
import type { Logger } from '../../../src/core/logger';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

// --- Fakes -----------------------------------------------------------------

/** The bot's client id used across the suite. */
const BOT_ID = 'bot-1';
/** A literal mention of the bot, as it appears in message content. */
const botMention = `<@${BOT_ID}>`;

/**
 * Silent logger whose `error` is a spy, for the cases that assert a failure
 * was logged. `logError` logs through a per-guild child, so `child` returns
 * the logger itself to keep the spy on the path.
 */
const spyLogger = () => {
  const logger = silentLogger();
  vi.spyOn(logger, 'child').mockReturnValue(logger);
  const error = vi.spyOn(logger, 'error');
  return { logger, error };
};

interface FakeMsgInput {
  readonly name: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly bot?: boolean;
}

const makeFetchedMessage = (input: FakeMsgInput): Message =>
  buildMessage({
    author: { displayName: input.name, bot: input.bot ?? false },
    // Distinct guild nickname sentinel: the transcript must use the global
    // display name (author.displayName), never this member nickname.
    member: { displayName: `nick-${input.name}` },
    content: input.content,
    createdTimestamp: input.createdTimestamp,
  });

/** A channel whose `messages.fetch` resolves the given messages newest-first. */
const makeChannel = (messages: readonly Message[], name = 'general') => {
  const fetch = vi.fn().mockResolvedValue(new Map(messages.map((m, i) => [`id-${i}`, m])));
  const send = vi.fn().mockResolvedValue(undefined);
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    name,
    messages: { fetch },
    send,
  };
  return { channel, fetch, send };
};

const makeTriggerMessage = (
  channel: unknown,
  overrides: Partial<{
    authorBot: boolean;
    guildId: string | null;
    channelId: string;
    content: string;
    createdTimestamp: number;
    /** Whether the message @-mentions the bot (deterministic trigger). */
    mention: boolean;
  }> = {},
) =>
  buildMessage({
    author: { bot: overrides.authorBot ?? false, displayName: 'Trigger' },
    content: overrides.content ?? '',
    guildId: overrides.guildId === undefined ? 'g-1' : overrides.guildId,
    channelId: overrides.channelId ?? 'c-1',
    createdTimestamp: overrides.createdTimestamp ?? 0,
    // discord.js `MessageMentions#has`; the fake reports the override.
    mentions: { has: () => overrides.mention ?? false },
    channel,
  });

// --- Pure helpers ----------------------------------------------------------

describe('buildTranscript', () => {
  const at = (n: number): TranscriptMessage => ({
    displayName: `U${n}`,
    content: `m${n}`,
    createdTimestamp: n,
    isBot: false,
  });

  it('renders one line per message in order, joined by newlines (no channel prefix)', () => {
    expect(buildTranscript([at(1), at(2), at(3)])).toBe('U1: m1\nU2: m2\nU3: m3');
  });

  it('drops bot-authored and blank-content messages', () => {
    const messages: TranscriptMessage[] = [
      { displayName: 'Alice', content: 'hi', createdTimestamp: 1, isBot: false },
      { displayName: 'Bot', content: 'beep', createdTimestamp: 2, isBot: true },
      { displayName: 'Bob', content: '   ', createdTimestamp: 3, isBot: false },
      { displayName: 'Alice', content: ' bye ', createdTimestamp: 4, isBot: false },
    ];
    expect(buildTranscript(messages)).toBe('Alice: hi\nAlice: bye');
  });

  it('returns an empty string when nothing human remains', () => {
    const messages: TranscriptMessage[] = [
      { displayName: 'Bot', content: 'x', createdTimestamp: 1, isBot: true },
      { displayName: 'Carl', content: '', createdTimestamp: 2, isBot: false },
    ];
    expect(buildTranscript(messages)).toBe('');
  });
});

describe('isWithinWindow', () => {
  it('is true when the span is within the window (order independent)', () => {
    expect(isWithinWindow([5000, 1000, 3000], 4000)).toBe(true);
    expect(isWithinWindow([1000, 1000], 0)).toBe(true);
  });

  it('is false when the span exceeds the window', () => {
    expect(isWithinWindow([1000, 6000], 4000)).toBe(false);
  });

  it('is false for an empty input', () => {
    expect(isWithinWindow([], 4000)).toBe(false);
  });
});

describe('bot-mention trigger', () => {
  const msgWith = (has: (id: string, opts?: { ignoreRepliedUser?: boolean }) => boolean): Message =>
    buildMessage({ mentions: { has } });

  it('detects an @-mention of the bot, ignoring replied-user mentions', () => {
    const has = vi.fn(() => true);
    expect(mentionsBot(msgWith(has), BOT_ID)).toBe(true);
    expect(has).toHaveBeenCalledWith(BOT_ID, { ignoreRepliedUser: true });
  });

  it('is false when the bot is not mentioned', () => {
    expect(
      mentionsBot(
        msgWith(() => false),
        BOT_ID,
      ),
    ).toBe(false);
  });

  it('strips the bot mention (both <@id> and <@!id>) from content', () => {
    expect(stripBotMention(`${botMention} hello`, BOT_ID)).toBe('hello');
    expect(stripBotMention(`<@!${BOT_ID}>  hi there`, BOT_ID)).toBe('hi there');
  });

  it('leaves other-user mentions and plain content unchanged', () => {
    expect(stripBotMention('<@other> hello', BOT_ID)).toBe('<@other> hello');
    expect(stripBotMention('hello world', BOT_ID)).toBe('hello world');
  });
});

describe('ReplyCooldown', () => {
  it('is ready for a channel that has never replied', () => {
    expect(new ReplyCooldown(60_000).isReady('c-1', 1000)).toBe(true);
  });

  it('blocks within the cooldown and allows once it elapses', () => {
    const cd = new ReplyCooldown(60_000);
    cd.record('c-1', 1000);
    expect(cd.isReady('c-1', 1000 + 59_000)).toBe(false);
    expect(cd.isReady('c-1', 1000 + 60_000)).toBe(true);
  });

  it('tracks channels independently', () => {
    const cd = new ReplyCooldown(60_000);
    cd.record('c-1', 1000);
    expect(cd.isReady('c-1', 2000)).toBe(false);
    expect(cd.isReady('c-2', 2000)).toBe(true);
  });

  it('is always ready when the cooldown is disabled (<= 0)', () => {
    const cd = new ReplyCooldown(0);
    cd.record('c-1', 1000);
    // Query EARLIER than the recorded time: only the dedicated disable
    // branch (not the now-last>=0 comparison) keeps this ready.
    expect(cd.isReady('c-1', 999)).toBe(true);
  });

  it('records monotonically: an out-of-order smaller timestamp does not regress', () => {
    const cd = new ReplyCooldown(60_000);
    cd.record('c-1', 10_000);
    cd.record('c-1', 5_000); // older message, interleaved
    // The later timestamp (10_000) is retained, so the cooldown is measured
    // from it, not from the regressed 5_000.
    expect(cd.isReady('c-1', 10_000 + 59_000)).toBe(false);
    expect(cd.isReady('c-1', 10_000 + 60_000)).toBe(true);
  });
});

describe('InFlightChannels', () => {
  it('stays active until every overlapping attempt ends (reference counted)', () => {
    const f = new InFlightChannels();
    expect(f.isActive('c')).toBe(false);
    f.begin('c');
    f.begin('c'); // an overlapping (e.g. forced) attempt on the same channel
    f.end('c');
    expect(f.isActive('c')).toBe(true); // still one holder -> a Set would be empty here
    f.end('c');
    expect(f.isActive('c')).toBe(false);
  });

  it('tracks channels independently', () => {
    const f = new InFlightChannels();
    f.begin('a');
    expect(f.isActive('a')).toBe(true);
    expect(f.isActive('b')).toBe(false);
  });
});

describe('clampReply', () => {
  it('returns text unchanged when it fits the limit', () => {
    expect(clampReply('hi')).toBe('hi');
    const exact = 'x'.repeat(MAX_DISCORD_MESSAGE_LENGTH);
    expect(clampReply(exact)).toBe(exact);
  });

  it('truncates an over-long reply to exactly the limit with an ellipsis', () => {
    const result = clampReply('x'.repeat(MAX_DISCORD_MESSAGE_LENGTH + 500));
    expect(result.length).toBe(MAX_DISCORD_MESSAGE_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

// --- Orchestrator ----------------------------------------------------------

const ORCH_CONFIG = { messageCount: 5, windowSeconds: 30 } as const;

/** Orchestrator deps with the injected fake client + bot id. */
const orchDeps = (
  reply: RunLlmAutoReplyDeps['client']['reply'],
  logger: Logger = silentLogger(),
): RunLlmAutoReplyDeps => ({ client: { reply }, logger, config: ORCH_CONFIG, clientId: BOT_ID });

const burst = (): Message[] => [
  // newest-first, as discord.js returns; one bot line is excluded.
  makeFetchedMessage({ name: 'Bob', content: 'd', createdTimestamp: 4000 }),
  makeFetchedMessage({ name: 'Alice', content: 'c', createdTimestamp: 3000 }),
  makeFetchedMessage({ name: 'NijikaBot', content: 'prev', createdTimestamp: 2000, bot: true }),
  makeFetchedMessage({ name: 'Bob', content: 'b', createdTimestamp: 1000 }),
  makeFetchedMessage({ name: 'Alice', content: 'a', createdTimestamp: 0 }),
];

describe('runLlmAutoReply', () => {
  it('builds the transcript, calls the client, and posts one reply (happy path)', async () => {
    const { channel, send } = makeChannel(burst());
    const reply = vi.fn().mockResolvedValue(ok('生成的回覆'));

    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledWith('Alice: a\nBob: b\nAlice: c\nBob: d');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ content: '生成的回覆', allowedMentions: { parse: [] } });
  });

  it('truncates an over-long LLM reply to the Discord limit before sending', async () => {
    const { channel, send } = makeChannel(burst());
    const reply = vi.fn().mockResolvedValue(ok('y'.repeat(MAX_DISCORD_MESSAGE_LENGTH + 1000)));
    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = (send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: string };
    expect(payload.content.length).toBe(MAX_DISCORD_MESSAGE_LENGTH);
  });

  it('does not send when the LLM reply is blank', async () => {
    const { channel, send } = makeChannel(burst());
    const reply = vi.fn().mockResolvedValue(ok('   '));
    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when fewer than N messages were fetched', async () => {
    const { channel, send } = makeChannel(burst().slice(0, 3)); // 3 < 5
    const reply = vi.fn();
    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('logs and stays silent when the message fetch rejects', async () => {
    // A real DiscordApiError (missing access, rate limit, ...) must be
    // observable — distinct from the by-design silent "fewer than N" path.
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = {
      isTextBased: () => true,
      isSendable: () => true,
      name: 'general',
      messages: { fetch: vi.fn().mockRejectedValue(new Error('Missing Access')) },
      send,
    };
    const reply = vi.fn();
    const { logger, error } = spyLogger();
    const sent = await runLlmAutoReply(orchDeps(reply, logger), makeTriggerMessage(channel));

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a non-mention message spans beyond the window', async () => {
    const messages = burst();
    // Push the oldest far back so the span exceeds 30s.
    messages[4] = makeFetchedMessage({ name: 'Alice', content: 'a', createdTimestamp: -60_000 });
    const { channel, send } = makeChannel(messages);
    const reply = vi.fn();
    const sent = await runLlmAutoReply(
      orchDeps(reply),
      makeTriggerMessage(channel), // mention: false -> window check applies
    );

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the window check for an @-mention message that spans beyond the window', async () => {
    const messages = burst();
    // Same out-of-window burst that blocks a normal trigger above.
    messages[4] = makeFetchedMessage({ name: 'Alice', content: 'a', createdTimestamp: -600_000 });
    const { channel, send } = makeChannel(messages);
    const reply = vi.fn().mockResolvedValue(ok('forced reply'));
    const sent = await runLlmAutoReply(
      orchDeps(reply),
      makeTriggerMessage(channel, { mention: true }),
    );

    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does nothing when only bot/blank messages remain', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeFetchedMessage({ name: 'Bot', content: 'x', createdTimestamp: i * 100, bot: true }),
    );
    const { channel, send } = makeChannel(messages);
    const reply = vi.fn();
    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('stays silent and logs when the client returns an error', async () => {
    const { channel, send } = makeChannel(burst());
    const { logger, error } = spyLogger();
    const reply = vi.fn().mockResolvedValue(
      err(
        new ExternalServiceError({
          code: 'EXTERNAL_SERVICE_FAILURE',
          messageKey: 'errors:llm.unknown',
          context: { operation: 'test' },
        }),
      ),
    );
    const sent = await runLlmAutoReply(orchDeps(reply, logger), makeTriggerMessage(channel));

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("strips the bot's @-mention from transcript content", async () => {
    const messages: Message[] = [
      makeFetchedMessage({
        name: 'Bob',
        content: `${botMention}  give advice`,
        createdTimestamp: 4000,
      }),
      makeFetchedMessage({ name: 'Alice', content: 'c', createdTimestamp: 3000 }),
      makeFetchedMessage({ name: 'Bob', content: 'b', createdTimestamp: 2000 }),
      makeFetchedMessage({ name: 'Alice', content: 'a', createdTimestamp: 1000 }),
      makeFetchedMessage({ name: 'Bob', content: 'z', createdTimestamp: 0 }),
    ];
    const { channel, send } = makeChannel(messages);
    const reply = vi.fn().mockResolvedValue(ok('ok'));
    const sent = await runLlmAutoReply(orchDeps(reply), makeTriggerMessage(channel));

    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledWith('Bob: z\nAlice: a\nBob: b\nAlice: c\nBob: give advice');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// --- Plugin guards + probability gate --------------------------------------

describe('createLlmAutoReplyPlugin messageCreate', () => {
  const dispatch = async (
    plugin: ReturnType<typeof createLlmAutoReplyPlugin>,
    message: Message,
    logger: Logger = silentLogger(),
  ): Promise<void> => {
    // The discord.js messageCreate param is `OmitPartialGroupDMChannel<Message>`;
    // the structural fake is widened through `never` for the call site only.
    await plugin.events?.messageCreate?.(buildPluginContext({ logger }), message as never);
  };

  it('keeps the configured endpoint until the plugin is rebuilt after a settings change', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { status: 'success', response: 'reply' } });
    try {
      const config = { enabled: true, endpoint: 'https://first.invalid/chat', timeoutMs: 4321 };
      const plugin = createLlmAutoReplyPlugin(config, { clientId: BOT_ID });
      const { channel, send } = makeChannel(burst());

      await dispatch(plugin, makeTriggerMessage(channel, { mention: true }));
      config.endpoint = 'https://second.invalid/chat';
      await dispatch(plugin, makeTriggerMessage(channel, { mention: true }));

      const restarted = createLlmAutoReplyPlugin(config, { clientId: BOT_ID });
      await dispatch(restarted, makeTriggerMessage(channel, { mention: true }));

      expect(post).toHaveBeenCalledTimes(3);
      for (const call of [1, 2]) {
        expect(post).toHaveBeenNthCalledWith(
          call,
          'https://first.invalid/chat',
          expect.objectContaining({ messages: [expect.objectContaining({ role: 'user' })] }),
          expect.objectContaining({ timeout: 4321 }),
        );
      }
      expect(post).toHaveBeenNthCalledWith(
        3,
        'https://second.invalid/chat',
        expect.anything(),
        expect.objectContaining({ timeout: 4321 }),
      );
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      post.mockRestore();
    }
  });

  it('rolls the probability gate before any fetch (gate fail -> no fetch)', async () => {
    const { channel, fetch } = makeChannel(burst());
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true },
      { clientId: BOT_ID, random: () => 0.9 },
    );
    await dispatch(plugin, makeTriggerMessage(channel));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('reaches the fetch once the gate passes, then bails at the count gate', async () => {
    // fetch returns < N so the orchestrator bails at the count gate; the
    // injected client makes "bailed at count, not at the network" load-bearing.
    const { channel, fetch, send } = makeChannel(burst().slice(0, 2));
    const reply = vi.fn().mockResolvedValue(ok('x'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    await dispatch(plugin, makeTriggerMessage(channel));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    const { channel, fetch } = makeChannel(burst());
    const plugin = createLlmAutoReplyPlugin(
      { enabled: false },
      { clientId: BOT_ID, random: () => 0 },
    );
    await dispatch(plugin, makeTriggerMessage(channel));

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['bot author', { authorBot: true }],
    ['DM (no guild)', { guildId: null as string | null }],
  ])('skips %s', async (_label, overrides) => {
    const { channel, fetch } = makeChannel(burst());
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true },
      { clientId: BOT_ID, random: () => 0 },
    );
    await dispatch(plugin, makeTriggerMessage(channel, overrides));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('bypasses the probability gate for an @-mention but still honours the count gate', async () => {
    // random() = 0.9 would normally block (>= 0.05); the @-mention forces it.
    // fetch returns < N, so the count gate still bails before the client —
    // proving the mention skips the dice and the window, but not the
    // message-count requirement.
    const { channel, fetch, send } = makeChannel(burst().slice(0, 2));
    const reply = vi.fn().mockResolvedValue(ok('x'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true },
      { clientId: BOT_ID, random: () => 0.9, client: { reply } },
    );
    await dispatch(plugin, makeTriggerMessage(channel, { mention: true }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one reply for an @-mention with a full valid burst', async () => {
    // The marquee behaviour: @-mention + enough recent context => a reply IS
    // sent even though random() = 0.9 would have blocked the dice roll.
    const { channel, send } = makeChannel(burst()); // size === messageCount, within window
    const reply = vi.fn().mockResolvedValue(ok('forced reply'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true },
      { clientId: BOT_ID, random: () => 0.9, client: { reply } },
    );
    await dispatch(plugin, makeTriggerMessage(channel, { mention: true }));

    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ content: 'forced reply', allowedMentions: { parse: [] } });
  });

  it.each([
    ['disabled', { enabled: false }, {}],
    ['bot author', { enabled: true }, { authorBot: true }],
  ])('does not let an @-mention override the %s guard', async (_label, rawConfig, overrides) => {
    const { channel, fetch } = makeChannel(burst());
    const plugin = createLlmAutoReplyPlugin(rawConfig, {
      clientId: BOT_ID,
      random: () => 0.9,
    });
    await dispatch(plugin, makeTriggerMessage(channel, { ...overrides, mention: true }));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks a second automatic reply within the per-channel cooldown window', async () => {
    const reply = vi.fn().mockResolvedValue(ok('r'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 60 },
      { clientId: BOT_ID, random: () => 0, client: { reply } }, // gate always passes
    );
    // First automatic reply at t=0 sends and records the cooldown.
    const first = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(first.channel, { createdTimestamp: 0 }));
    expect(first.send).toHaveBeenCalledTimes(1);

    // 30s later (< 60s) in the same channel: blocked before any fetch.
    const within = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(within.channel, { createdTimestamp: 30_000 }));
    expect(within.fetch).not.toHaveBeenCalled();
    expect(within.send).not.toHaveBeenCalled();

    // 60s+ later: the cooldown has elapsed, so it replies again.
    const after = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(after.channel, { createdTimestamp: 61_000 }));
    expect(after.send).toHaveBeenCalledTimes(1);
  });

  it('lets an @-mention reply bypass the cooldown', async () => {
    const reply = vi.fn().mockResolvedValue(ok('r'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 60 },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    // Automatic reply at t=0 records the cooldown.
    const first = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(first.channel, { createdTimestamp: 0 }));
    expect(first.send).toHaveBeenCalledTimes(1);

    // @-mention at t=1000 (well within the 60s cooldown) still replies.
    const forced = makeChannel(burst());
    await dispatch(
      plugin,
      makeTriggerMessage(forced.channel, { createdTimestamp: 1_000, mention: true }),
    );
    expect(forced.send).toHaveBeenCalledTimes(1);
  });

  it('records the cooldown for an @-mention reply, blocking a later automatic reply', async () => {
    const reply = vi.fn().mockResolvedValue(ok('r'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 60 },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    // auto@0 records, but will be long-elapsed by the final check.
    const a0 = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(a0.channel, { createdTimestamp: 0 }));
    expect(a0.send).toHaveBeenCalledTimes(1);

    // mention@61000: auto@0 has already elapsed; the mention bypasses the
    // check and records 61000.
    const forced = makeChannel(burst());
    await dispatch(
      plugin,
      makeTriggerMessage(forced.channel, { createdTimestamp: 61_000, mention: true }),
    );
    expect(forced.send).toHaveBeenCalledTimes(1);

    // auto@90000 is blocked ONLY because the @-mention reply recorded at 61000
    // (90000 - 61000 < 60000); auto@0 (90000 - 0) is long elapsed, so this
    // would NOT block if the mention reply had not recorded.
    const auto = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(auto.channel, { createdTimestamp: 90_000 }));
    expect(auto.fetch).not.toHaveBeenCalled();
    expect(auto.send).not.toHaveBeenCalled();
  });

  it('does not start the cooldown when a gated attempt sends nothing', async () => {
    const reply = vi.fn().mockResolvedValue(ok('r'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 60 },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    // First automatic message passes the gate but the orchestrator bails at
    // the count gate (< N), so nothing is sent and the cooldown is NOT recorded.
    const noSend = makeChannel(burst().slice(0, 2));
    await dispatch(plugin, makeTriggerMessage(noSend.channel, { createdTimestamp: 0 }));
    expect(noSend.send).not.toHaveBeenCalled();

    // A second automatic message 1s later (well within the cooldown) must still
    // reply, because the no-send attempt did not reserve the cooldown.
    const second = makeChannel(burst());
    await dispatch(plugin, makeTriggerMessage(second.channel, { createdTimestamp: 1_000 }));
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it('blocks a concurrent automatic reply in the same channel while one is in flight', async () => {
    const reply = vi.fn().mockResolvedValue(ok('r'));
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 60 },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    const a = makeChannel(burst());
    const b = makeChannel(burst());
    // Start both handlers before awaiting either: the first marks the channel
    // in-flight synchronously (before its first await), so the second bails
    // even though neither has recorded the cooldown yet.
    const p1 = dispatch(plugin, makeTriggerMessage(a.channel, { createdTimestamp: 0 }));
    const p2 = dispatch(plugin, makeTriggerMessage(b.channel, { createdTimestamp: 100 }));
    await Promise.all([p1, p2]);

    expect(b.fetch).not.toHaveBeenCalled();
    const totalSends = a.send.mock.calls.length + b.send.mock.calls.length;
    expect(totalSends).toBe(1);
  });

  it('keeps the in-flight guard until the last overlapping attempt finishes (mention overlap)', async () => {
    // cooldownSeconds: 0 so ONLY the in-flight guard can block the final auto.
    const resolvers: Array<(v: unknown) => void> = [];
    const reply = vi.fn().mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const plugin = createLlmAutoReplyPlugin(
      { enabled: true, cooldownSeconds: 0 },
      { clientId: BOT_ID, random: () => 0, client: { reply } },
    );
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    const a = makeChannel(burst());
    const b = makeChannel(burst());
    const c = makeChannel(burst());

    // A (automatic) and B (@-mention) both reach client.reply and park there,
    // so both are in flight on the same channel at once.
    const pA = dispatch(plugin, makeTriggerMessage(a.channel, { createdTimestamp: 0 }));
    const pB = dispatch(
      plugin,
      makeTriggerMessage(b.channel, { createdTimestamp: 1, mention: true }),
    );
    await flush();
    expect(reply).toHaveBeenCalledTimes(2);

    // Finish A: it sends and runs its `finally`, decrementing the in-flight count.
    resolvers[0]!(ok('rA'));
    await pA;

    // C (automatic) arrives while B is STILL in flight: it must be blocked,
    // because the in-flight count is still > 0 (B holds it). A plain Set would
    // have been cleared by A's `finally` and wrongly let C through.
    await dispatch(plugin, makeTriggerMessage(c.channel, { createdTimestamp: 2 }));
    expect(c.fetch).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();

    // Cleanup: finish B.
    resolvers[1]!(ok('rB'));
    await pB;
  });
});
