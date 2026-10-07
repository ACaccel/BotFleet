import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import ThreadList from '../../../src/handlers/buttons/thread_list';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';

const OWNER = '100000000000000001';
const THREAD = '100000000000000002';
const BOT = '100000000000000003';
const USERS = Array.from({ length: 41 }, (_, i) => String(100000000000000010n + BigInt(i)));

const build = () => {
  const listBlocked = vi.fn().mockResolvedValue({ ok: true, value: USERS });
  const isManager = vi.fn().mockResolvedValue({ ok: true, value: false });
  const fetch = vi.fn().mockResolvedValue({ id: THREAD, ownerId: OWNER });
  const { bot, logger } = buildFakeBot({
    clientId: BOT,
    threadModerationEnabled: true,
    isAdmin: () => false,
    getRepos: () => ({ threadModeration: { listBlocked, isManager } }),
  });
  bot.translator = echoTranslatorWithParams();
  const data = {
    customId: `thread_list|${OWNER}|${THREAD}|2`,
    user: { id: OWNER },
    guild: { id: 'guild' },
    guildId: 'guild',
    channelId: THREAD,
    channel: { isThread: () => true, fetch },
    message: {
      author: { id: BOT },
      flags: { has: vi.fn().mockReturnValue(true) },
      interactionMetadata: { user: { id: OWNER } },
    },
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      data.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return {
    data,
    bot,
    logger,
    listBlocked,
    isManager,
    fetch,
    interaction: data as unknown as ButtonInteraction,
  };
};

const run = async (f: ReturnType<typeof build>) => new ThreadList().execute(f.interaction, f.bot);

describe('thread list navigation', () => {
  it('fetches live restrictions and edits the private message without pinging users', async () => {
    const f = build();
    await run(f);
    expect(f.data.deferUpdate).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.listBlocked).toHaveBeenCalledWith(BOT, THREAD);
    const reply = f.data.editReply.mock.calls[0]?.[0];
    expect(reply.content).toContain('"page":2,"pages":3');
    expect(reply.content).toContain(USERS[20]);
    expect(reply.content).toContain(USERS[39]);
    expect(reply.content).not.toContain(USERS[40]);
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(
      reply.components[0].toJSON().components.map((b: { custom_id: string }) => b.custom_id),
    ).toEqual([
      `thread_list|${OWNER}|${THREAD}|1`,
      `thread_list|${OWNER}|${THREAD}|2`,
      `thread_list|${OWNER}|${THREAD}|3`,
    ]);
  });

  it('clamps a stale page when bans have been removed', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue({ ok: true, value: [USERS[0]] });
    await run(f);
    expect(f.data.editReply.mock.calls[0]?.[0].content).toContain('"page":1,"pages":1');
  });

  it('clears removed users and disables navigation on an empty list', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue({ ok: true, value: [] });
    await run(f);
    const reply = f.data.editReply.mock.calls[0]?.[0];
    expect(reply.content).toBe('replies:thread_moderation.list_empty');
    expect(
      reply.components[0].toJSON().components.map((b: { disabled: boolean }) => b.disabled),
    ).toEqual([true, false, true]);
  });

  it('rejects another actor without editing the original message', async () => {
    const f = build();
    f.data.user.id = BOT;
    await run(f);
    expect(f.data.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: 'replies:thread_moderation.list_forbidden',
      }),
    );
    expect(f.data.editReply).not.toHaveBeenCalled();
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'cross-channel', 'wrong-author', 'wrong-origin', 'public'])(
    'rejects %s controls before reading restrictions',
    async (kind) => {
      const f = build();
      if (kind === 'malformed') f.data.customId = 'thread_list|oops';
      if (kind === 'cross-channel') f.data.channelId = BOT;
      if (kind === 'wrong-author') f.data.message.author.id = OWNER;
      if (kind === 'wrong-origin') f.data.message.interactionMetadata.user.id = BOT;
      if (kind === 'public') f.data.message.flags.has.mockReturnValue(false);
      await run(f);
      expect(f.data.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'replies:thread_moderation.list_stale' }),
      );
      expect(f.data.editReply).not.toHaveBeenCalled();
      expect(f.listBlocked).not.toHaveBeenCalled();
    },
  );

  it('rechecks delegated permission and removes controls when revoked', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    await run(f);
    expect(f.isManager).toHaveBeenCalledWith(BOT, THREAD, OWNER);
    expect(f.listBlocked).not.toHaveBeenCalled();
    expect(f.data.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:thread_moderation.forbidden', components: [] }),
    );
  });

  it('allows an active delegated manager', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    f.isManager.mockResolvedValue({ ok: true, value: true });
    await run(f);
    expect(f.listBlocked).toHaveBeenCalledOnce();
  });

  it('reports read failures with a trace and disarms the controls', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue({ ok: false, error: new Error('read failed') });
    await run(f);
    expect(f.data.editReply).toHaveBeenCalledWith({ components: [] });
    expect(f.data.editReply).toHaveBeenLastCalledWith({
      content: expect.stringMatching(/^replies:thread_moderation.list_failed:.*traceId/u),
    });
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('removes controls if moderation has been disabled', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await run(f);
    expect(f.data.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:thread_moderation.disabled', components: [] }),
    );
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable persistence without showing a stale list', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await run(f);
    expect(f.data.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:thread_moderation.unavailable', components: [] }),
    );
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('fails closed on an authorization lookup failure', async () => {
    const f = build();
    f.fetch.mockResolvedValue({ id: THREAD, ownerId: BOT });
    f.isManager.mockResolvedValue({ ok: false, error: new Error('authorization failed') });
    await run(f);
    expect(f.listBlocked).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
});
