import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import ThreadBan from '../../../src/handlers/commands/thread_ban/action';
import ThreadAllow from '../../../src/handlers/commands/thread_allow/action';
import ThreadList from '../../../src/handlers/commands/thread_list/action';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';

const OWNER = '100000000000000001';
const TARGET = '100000000000000002';
const OTHER = '100000000000000003';
const ADMIN = '100000000000000004';

const build = () => {
  const setBlocked = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const listBlocked = vi.fn().mockResolvedValue({ ok: true, value: [TARGET, OTHER] });
  const isManager = vi.fn().mockResolvedValue({ ok: true, value: false });
  const has = vi.fn().mockReturnValue(true);
  const thread = { id: 'thread', ownerId: OWNER, permissionsFor: () => ({ has }) };
  const fetchMember = vi.fn().mockResolvedValue({ user: { bot: false } });
  const fetchThread = vi.fn().mockResolvedValue(thread);
  const { bot, logger } = buildFakeBot({
    clientId: 'this-bot',
    threadModerationEnabled: true,
    isAdmin: (id: string) => id === ADMIN,
    getRepos: () => ({ threadModeration: { setBlocked, listBlocked, isManager } }),
  });
  const data = {
    user: { id: OWNER },
    guildId: 'guild',
    guild: { id: 'guild', members: { fetchMe: vi.fn().mockResolvedValue({}), fetch: fetchMember } },
    channel: { isThread: vi.fn().mockReturnValue(true), fetch: fetchThread },
    options: {
      getString: vi.fn().mockReturnValue(TARGET),
      getInteger: vi.fn().mockReturnValue(null),
    },
    deferred: true,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  const interaction = data as unknown as ChatInputCommandInteraction;
  return {
    bot,
    logger,
    data,
    interaction,
    setBlocked,
    isManager,
    listBlocked,
    thread,
    has,
    fetchMember,
    fetchThread,
  };
};

const expectReply = (data: ReturnType<typeof build>['data'], key: string): void => {
  expect(data.editReply).toHaveBeenLastCalledWith({
    content: `replies:thread_moderation.${key}`,
    allowedMentions: { parse: [] },
  });
};

describe('thread moderation commands', () => {
  it('allows the refreshed thread owner to ban several distinct users in this bot only', async () => {
    const f = build();
    f.data.options.getString.mockReturnValue(`<@${TARGET}> <@!${OTHER}>,${TARGET}`);
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.data.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.fetchThread).toHaveBeenCalledOnce();
    expect(f.has).toHaveBeenCalledWith([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageMessages,
    ]);
    expect(f.setBlocked).toHaveBeenCalledWith('this-bot', 'thread', [TARGET, OTHER], true);
    expectReply(f.data, 'banned');
  });

  it('allows a configured admin who is not the owner', async () => {
    const f = build();
    f.data.user.id = ADMIN;
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.setBlocked).toHaveBeenCalledOnce();
  });

  it('denies other users without writing', async () => {
    const f = build();
    f.data.user.id = OTHER;
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'forbidden');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('restores absent members without needing deletion permissions', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    f.fetchMember.mockRejectedValue(new Error('Member left'));
    await new ThreadAllow().execute(f.interaction, f.bot);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.setBlocked).toHaveBeenCalledWith('this-bot', 'thread', [TARGET], false);
    expectReply(f.data, 'allowed');
  });

  it('denies a ban if the bot cannot delete messages', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'missing_permissions');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it.each([OWNER, ADMIN])(
    'rejects an entire batch containing protected user %s',
    async (protectedId) => {
      const f = build();
      f.data.options.getString.mockReturnValue(`${TARGET} ${protectedId}`);
      await new ThreadBan().execute(f.interaction, f.bot);
      expectReply(f.data, 'protected_user');
      expect(f.setBlocked).not.toHaveBeenCalled();
    },
  );

  it('protects bot accounts', async () => {
    const f = build();
    f.fetchMember.mockResolvedValue({ user: { bot: true } });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'protected_user');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '123',
    `<@&${TARGET}>`,
    `${TARGET} invalid`,
    '99999999999999999999',
    Array.from({ length: 21 }, (_, i) => String(100000000000000000n + BigInt(i))).join(' '),
  ])('rejects invalid input: %s', async (input) => {
    const f = build();
    f.data.options.getString.mockReturnValue(input);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'invalid_users');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('requires a thread', async () => {
    const f = build();
    f.data.channel.isThread.mockReturnValue(false);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'thread_only');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('requires this bot to enable moderation', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'disabled');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('rejects the whole batch when a member has left the server', async () => {
    const f = build();
    f.fetchMember.mockRejectedValue({ code: 10007 });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'unknown_member');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable repositories', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'unavailable');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('logs storage errors and does not claim success', async () => {
    const f = build();
    f.bot.translator = echoTranslatorWithParams();
    f.setBlocked.mockResolvedValue({ ok: false, error: new Error('Write failed') });
    await new ThreadBan().execute(f.interaction, f.bot);
    const reply = f.data.editReply.mock.calls[0]?.[0] as { content: string };
    const match = /^replies:thread_moderation\.failed:\{"traceId":"([a-z0-9]{6})"\}$/u.exec(
      reply.content,
    );
    expect(match).not.toBeNull();
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining(`traceId=${match?.[1]}`));
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
});

describe('thread_list', () => {
  it.each([OWNER, ADMIN])(
    'lets authorized user %s privately list this bot and thread only',
    async (actor) => {
      const f = build();
      f.data.user.id = actor;
      await new ThreadList().execute(f.interaction, f.bot);
      expect(f.data.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(f.fetchThread).toHaveBeenCalledOnce();
      expect(f.listBlocked).toHaveBeenCalledWith('this-bot', 'thread');
      expect(f.data.editReply).toHaveBeenLastCalledWith({
        content: `replies:thread_moderation.list_header\n<@${TARGET}> (\`${TARGET}\`)\n<@${OTHER}> (\`${OTHER}\`)`,
        allowedMentions: { parse: [] },
        components: expect.any(Array),
      });
      expect(f.setBlocked).not.toHaveBeenCalled();
    },
  );

  it('uses the refreshed thread owner for authorization', async () => {
    const f = build();
    f.fetchThread.mockResolvedValue({ ...f.thread, ownerId: OTHER });
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f.data, 'forbidden');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('denies other users before querying the ban list', async () => {
    const f = build();
    f.data.user.id = OTHER;
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f.data, 'forbidden');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('requires a thread', async () => {
    const f = build();
    f.data.channel.isThread.mockReturnValue(false);
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f.data, 'thread_only');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('requires moderation to be enabled for this bot', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f.data, 'disabled');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable repositories', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f.data, 'unavailable');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('lists persisted IDs without fetching members or requiring deletion permissions', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    f.fetchMember.mockRejectedValue(new Error('Member left'));
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.data.guild.members.fetchMe).not.toHaveBeenCalled();
    expect(f.has).not.toHaveBeenCalled();
    expect(f.data.editReply.mock.calls[0]?.[0].content).toContain(`<@${TARGET}>`);
  });

  it('explains when no users are banned', async () => {
    const f = build();
    f.listBlocked.mockResolvedValue({ ok: true, value: [] });
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.data.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'replies:thread_moderation.list_empty',
      }),
    );
  });

  it('starts long lists at page one with navigation controls', async () => {
    const f = build();
    const users = Array.from({ length: 21 }, (_, i) => String(100000000000000010n + BigInt(i)));
    f.listBlocked.mockResolvedValue({ ok: true, value: users });
    await new ThreadList().execute(f.interaction, f.bot);
    const reply = f.data.editReply.mock.calls[0]?.[0];
    expect(reply.content).toContain(users[19]);
    expect(reply.content).not.toContain(users[20]);
    expect(reply.components[0].toJSON().components).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: false }),
      expect.objectContaining({ disabled: false, custom_id: `thread_list|${OWNER}|thread|2` }),
    ]);
    expect(f.data.options.getInteger).not.toHaveBeenCalled();
  });

  it('allows a delegated manager to list restrictions', async () => {
    const f = build();
    f.data.user.id = OTHER;
    f.isManager.mockResolvedValue({ ok: true, value: true });
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.isManager).toHaveBeenCalledWith('this-bot', 'thread', OTHER);
    expect(f.listBlocked).toHaveBeenCalledOnce();
  });

  it('lets a delegated manager ban and restore other users', async () => {
    const f = build();
    f.data.user.id = OTHER;
    f.isManager.mockImplementation(async (_botId, _threadId, userId) => ({
      ok: true,
      value: userId === OTHER,
    }));
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'banned');
    await new ThreadAllow().execute(f.interaction, f.bot);
    expectReply(f.data, 'allowed');
    expect(f.setBlocked.mock.calls).toEqual([
      ['this-bot', 'thread', [TARGET], true, OTHER],
      ['this-bot', 'thread', [TARGET], false, OTHER],
    ]);
  });

  it.each([ThreadBan, ThreadAllow])(
    'does not report success when a delegate loses authority before the atomic write (%s)',
    async (Handler) => {
      const f = build();
      f.data.user.id = OTHER;
      f.bot.translator = echoTranslatorWithParams();
      f.isManager.mockImplementation(async (_botId, _threadId, userId) => ({
        ok: true,
        value: userId === OTHER,
      }));
      f.setBlocked.mockResolvedValue({ ok: false, error: new Error('Manager authority revoked') });
      await new Handler().execute(f.interaction, f.bot);
      expect(f.setBlocked).toHaveBeenCalledWith(
        'this-bot',
        'thread',
        [TARGET],
        Handler === ThreadBan,
        OTHER,
      );
      expect(f.data.editReply).toHaveBeenLastCalledWith({
        content: expect.stringMatching(/^replies:thread_moderation.failed:.*traceId/u),
      });
      expect(f.logger.error).toHaveBeenCalledOnce();
    },
  );

  it('does not ban users when their protected status cannot be read', async () => {
    const f = build();
    f.isManager.mockResolvedValue({ ok: false, error: new Error('Manager lookup failed') });
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.setBlocked).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('does not ban a delegated manager', async () => {
    const f = build();
    f.isManager.mockResolvedValue({ ok: true, value: true });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f.data, 'protected_user');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('reports storage errors with a trace ID instead of claiming the list is empty', async () => {
    const f = build();
    f.bot.translator = echoTranslatorWithParams();
    f.listBlocked.mockResolvedValue({ ok: false, error: new Error('Read failed') });
    await new ThreadList().execute(f.interaction, f.bot);
    const reply = f.data.editReply.mock.calls[0]?.[0] as {
      content: string;
    };
    const match = /^replies:thread_moderation\.list_failed:\{"traceId":"([a-z0-9]{6})"\}$/u.exec(
      reply.content,
    );
    expect(match).not.toBeNull();
    expect(reply.content).not.toContain(TARGET);
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining(`traceId=${match?.[1]}`));
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
});
