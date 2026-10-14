import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import ThreadList from '../../../src/handlers/buttons/thread_list';
import { err, ok, type Result } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const dbErr = (message: string) =>
  err(databaseErrorFrom(new Error(message), { operation: 'test' }));

const OWNER = '100000000000000001';
const THREAD = '100000000000000002';
const BOT = '100000000000000003';
const USERS = Array.from({ length: 41 }, (_, i) => String(100000000000000010n + BigInt(i)));

interface BuildOptions {
  readonly customId?: string;
  /** The user pressing the button. */
  readonly actor?: string;
  readonly channelId?: string;
  /** Who authored the message carrying the control. */
  readonly messageAuthor?: string;
  /** Who invoked the command the message answers. */
  readonly origin?: string;
  /** Whether the message is private (ephemeral). */
  readonly ephemeral?: boolean;
}

const build = (opts: BuildOptions = {}) => {
  const listBlocked = vi.fn(
    async (_bot: string, _thread: string): Promise<Result<string[]>> => ok(USERS),
  );
  const isManager = vi.fn(
    async (_bot: string, _thread: string, _user: string): Promise<Result<boolean>> => ok(false),
  );
  const fetch = vi.fn().mockResolvedValue({ id: THREAD, ownerId: OWNER });
  const { bot, logger } = buildFakeBot({
    clientId: BOT,
    threadModerationEnabled: true,
    isAdmin: () => false,
    getRepos: () => ({ threadModeration: { listBlocked, isManager } }),
  });
  bot.translator = echoTranslatorWithParams();
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: opts.customId ?? `thread_list|${OWNER}|${THREAD}|2`,
    userId: opts.actor ?? OWNER,
    guild: buildGuild({ id: 'guild' }),
    sink,
  });
  // The builder has no message or channel surface; the handler binds the
  // control to both.
  Object.assign(interaction, {
    channelId: opts.channelId ?? THREAD,
    channel: { isThread: () => true, fetch },
    message: {
      author: { id: opts.messageAuthor ?? BOT },
      flags: { has: () => opts.ephemeral ?? true },
      interactionMetadata: { user: { id: opts.origin ?? OWNER } },
    },
  });
  return { bot, logger, interaction, sink, listBlocked, isManager, fetch };
};

type Built = ReturnType<typeof build>;

const run = async (f: Built) => new ThreadList().execute(f.interaction, f.bot);

const buttonsOf = (reply: { components?: readonly unknown[] } | undefined) =>
  (reply?.components?.[0] as ActionRowBuilder<ButtonBuilder>).toJSON().components;

describe('thread list navigation', () => {
  it('fetches live restrictions and edits the private message without pinging users', async () => {
    const f = build();
    await run(f);
    expect(f.sink.deferUpdates).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.listBlocked).toHaveBeenCalledWith(BOT, THREAD);
    const reply = f.sink.editReplies[0];
    expect(reply?.content).toContain('"page":2,"pages":3');
    expect(reply?.content).toContain(USERS[20]);
    expect(reply?.content).toContain(USERS[39]);
    expect(reply?.content).not.toContain(USERS[40]);
    expect(reply?.allowedMentions).toEqual({ parse: [] });
    expect(buttonsOf(reply).map((b) => (b as { custom_id: string }).custom_id)).toEqual([
      `thread_list|${OWNER}|${THREAD}|1`,
      `thread_list|${OWNER}|${THREAD}|2`,
      `thread_list|${OWNER}|${THREAD}|3`,
    ]);
  });

  it('clamps a stale page when bans have been removed', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue(ok([USERS[0] as string]));
    await run(f);
    expect(f.sink.editReplies[0]?.content).toContain('"page":1,"pages":1');
  });

  it('clears removed users and disables navigation on an empty list', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue(ok([]));
    await run(f);
    const reply = f.sink.editReplies[0];
    expect(reply?.content).toBe('replies:thread_moderation.list_empty');
    expect(buttonsOf(reply).map((b) => (b as { disabled: boolean }).disabled)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('rejects another actor without editing the original message', async () => {
    const f = build({ actor: BOT });
    await run(f);
    expect(f.sink.replies).toEqual([
      {
        flags: MessageFlags.Ephemeral,
        content: 'replies:thread_moderation.list_forbidden',
        allowedMentions: { parse: [] },
      },
    ]);
    expect(f.sink.editReplies).toEqual([]);
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', { customId: 'thread_list|oops' }],
    ['cross-channel', { channelId: BOT }],
    ['wrong-author', { messageAuthor: OWNER }],
    ['wrong-origin', { origin: BOT }],
    ['public', { ephemeral: false }],
  ] as const)('rejects %s controls before reading restrictions', async (_kind, opts) => {
    const f = build(opts);
    await run(f);
    expect(f.sink.replies).toEqual([
      expect.objectContaining({ content: 'replies:thread_moderation.list_stale' }),
    ]);
    expect(f.sink.editReplies).toEqual([]);
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('rechecks delegated permission and removes controls when revoked', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    await run(f);
    expect(f.isManager).toHaveBeenCalledWith(BOT, THREAD, OWNER);
    expect(f.listBlocked).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([
      expect.objectContaining({ content: 'replies:thread_moderation.forbidden', components: [] }),
    ]);
  });

  it('allows an active delegated manager', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    f.isManager.mockResolvedValue(ok(true));
    await run(f);
    expect(f.listBlocked).toHaveBeenCalledOnce();
    expect(f.sink.editReplies[0]?.content).toContain('"page":2,"pages":3');
  });

  it('reports read failures with a trace and disarms the controls', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue(dbErr('read failed'));
    await run(f);
    expect(f.sink.editReplies[0]).toEqual({ components: [] });
    expect(f.sink.editReplies.at(-1)).toEqual({
      content: expect.stringMatching(/^replies:thread_moderation.list_failed:.*traceId/u),
    });
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('removes controls if moderation has been disabled', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await run(f);
    expect(f.sink.editReplies).toEqual([
      expect.objectContaining({ content: 'replies:thread_moderation.disabled', components: [] }),
    ]);
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable persistence without showing a stale list', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await run(f);
    expect(f.sink.editReplies).toEqual([
      expect.objectContaining({ content: 'replies:thread_moderation.unavailable', components: [] }),
    ]);
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('fails closed on an authorization lookup failure', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    f.isManager.mockResolvedValue(dbErr('authorization failed'));
    await run(f);
    expect(f.listBlocked).not.toHaveBeenCalled();
    expect(f.sink.editReplies[0]).toEqual({ components: [] });
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
});
