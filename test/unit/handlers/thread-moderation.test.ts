import { describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  PermissionFlagsBits,
  type ActionRowBuilder,
  type ButtonBuilder,
} from 'discord.js';
import { err, ok, type Result } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import ThreadBan from '../../../src/handlers/commands/thread_ban/action';
import ThreadAllow from '../../../src/handlers/commands/thread_allow/action';
import ThreadList from '../../../src/handlers/commands/thread_list/action';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const dbErr = (message: string) =>
  err(databaseErrorFrom(new Error(message), { operation: 'test' }));

const OWNER = '100000000000000001';
const TARGET = '100000000000000002';
const OTHER = '100000000000000003';
const ADMIN = '100000000000000004';

interface BuildOptions {
  /** Who runs the command; the thread owner by default. */
  readonly actor?: string;
  /** The raw `users` option. */
  readonly users?: string;
  /** Whether the command runs inside a thread. */
  readonly inThread?: boolean;
}

const build = (opts: BuildOptions = {}) => {
  // The repo mocks run over this set, so a test reads back who ended up
  // restricted rather than only which repo method was called.
  const blocked = new Set<string>([TARGET, OTHER]);
  const setBlocked = vi.fn(
    async (
      _bot: string,
      _thread: string,
      users: string[],
      enabled: boolean,
      _actor?: string,
    ): Promise<Result<void>> => {
      for (const user of users) {
        if (enabled) blocked.add(user);
        else blocked.delete(user);
      }
      return ok(undefined);
    },
  );
  const listBlocked = vi.fn(
    async (_bot: string, _thread: string): Promise<Result<string[]>> => ok([...blocked]),
  );
  const isManager = vi.fn(
    async (_bot: string, _thread: string, _user: string): Promise<Result<boolean>> => ok(false),
  );
  const has = vi.fn().mockReturnValue(true);
  const thread = { id: 'thread', ownerId: OWNER, permissionsFor: () => ({ has }) };
  const fetchMember = vi.fn().mockResolvedValue({ user: { bot: false } });
  const fetchMe = vi.fn().mockResolvedValue({});
  const fetchThread = vi.fn().mockResolvedValue(thread);
  const { bot, logger } = buildFakeBot({
    clientId: 'this-bot',
    threadModerationEnabled: true,
    isAdmin: (id: string) => id === ADMIN,
    getRepos: () => ({ threadModeration: { setBlocked, listBlocked, isManager } }),
  });
  const guild = buildGuild({ id: 'guild' });
  Object.assign(guild.members, { fetchMe, fetch: fetchMember });
  const channel = { id: 'thread', isThread: () => opts.inThread ?? true, fetch: fetchThread };
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: opts.actor ?? OWNER,
    guild,
    channel,
    sink,
  });
  const getInteger = vi.fn().mockReturnValue(null);
  Object.assign(interaction.options, {
    getString: () => opts.users ?? TARGET,
    getInteger,
  });
  return {
    bot,
    logger,
    interaction,
    sink,
    blocked,
    getInteger,
    setBlocked,
    isManager,
    listBlocked,
    thread,
    has,
    fetchMe,
    fetchMember,
    fetchThread,
  };
};

type Built = ReturnType<typeof build>;

const expectReply = (f: Built, key: string): void => {
  expect(f.sink.editReplies.at(-1)).toEqual({
    content: `replies:thread_moderation.${key}`,
    allowedMentions: { parse: [] },
  });
};

describe('thread moderation commands', () => {
  it('allows the refreshed thread owner to ban several distinct users in this bot only', async () => {
    const f = build({ users: `<@${TARGET}> <@!${OTHER}>,${TARGET}` });
    f.blocked.clear();
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(f.fetchThread).toHaveBeenCalledOnce();
    expect(f.has).toHaveBeenCalledWith([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageMessages,
    ]);
    expect(f.setBlocked).toHaveBeenCalledWith('this-bot', 'thread', [TARGET, OTHER], true);
    expect([...f.blocked]).toEqual([TARGET, OTHER]);
    expectReply(f, 'banned');
  });

  it('allows a configured admin who is not the owner', async () => {
    const f = build({ actor: ADMIN });
    f.blocked.clear();
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.setBlocked).toHaveBeenCalledOnce();
    expect([...f.blocked]).toEqual([TARGET]);
    expectReply(f, 'banned');
  });

  it('denies other users without writing', async () => {
    const f = build({ actor: OTHER });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'forbidden');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('restores absent members without needing deletion permissions', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    f.fetchMember.mockRejectedValue(new Error('Member left'));
    await new ThreadAllow().execute(f.interaction, f.bot);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.setBlocked).toHaveBeenCalledWith('this-bot', 'thread', [TARGET], false);
    expect([...f.blocked]).toEqual([OTHER]);
    expectReply(f, 'allowed');
  });

  it('denies a ban if the bot cannot delete messages', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'missing_permissions');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it.each([OWNER, ADMIN])(
    'rejects an entire batch containing protected user %s',
    async (protectedId) => {
      const f = build({ users: `${TARGET} ${protectedId}` });
      await new ThreadBan().execute(f.interaction, f.bot);
      expectReply(f, 'protected_user');
      expect(f.setBlocked).not.toHaveBeenCalled();
    },
  );

  it('protects bot accounts', async () => {
    const f = build();
    f.fetchMember.mockResolvedValue({ user: { bot: true } });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'protected_user');
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
    const f = build({ users: input });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'invalid_users');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('requires a thread', async () => {
    const f = build({ inThread: false });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'thread_only');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('requires this bot to enable moderation', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'disabled');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('rejects the whole batch when a member has left the server', async () => {
    const f = build();
    f.fetchMember.mockRejectedValue({ code: 10007 });
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'unknown_member');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable repositories', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'unavailable');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('logs storage errors and does not claim success', async () => {
    const f = build();
    f.bot.translator = echoTranslatorWithParams();
    f.setBlocked.mockResolvedValue(dbErr('Write failed'));
    await new ThreadBan().execute(f.interaction, f.bot);
    const content = f.sink.editReplies[0]?.content ?? '';
    const match = /^replies:thread_moderation\.failed:\{"traceId":"([a-z0-9]{6})"\}$/u.exec(
      content,
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
      const f = build({ actor });
      await new ThreadList().execute(f.interaction, f.bot);
      expect(f.sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(f.fetchThread).toHaveBeenCalledOnce();
      expect(f.listBlocked).toHaveBeenCalledWith('this-bot', 'thread');
      expect(f.sink.editReplies.at(-1)).toEqual({
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
    expectReply(f, 'forbidden');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('denies other users before querying the ban list', async () => {
    const f = build({ actor: OTHER });
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f, 'forbidden');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('requires a thread', async () => {
    const f = build({ inThread: false });
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f, 'thread_only');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('requires moderation to be enabled for this bot', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f, 'disabled');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('reports unavailable repositories', async () => {
    const f = build();
    vi.spyOn(f.bot, 'getRepos').mockReturnValue(undefined);
    await new ThreadList().execute(f.interaction, f.bot);
    expectReply(f, 'unavailable');
    expect(f.listBlocked).not.toHaveBeenCalled();
  });

  it('lists persisted IDs without fetching members or requiring deletion permissions', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    f.fetchMember.mockRejectedValue(new Error('Member left'));
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.fetchMe).not.toHaveBeenCalled();
    expect(f.has).not.toHaveBeenCalled();
    expect(f.sink.editReplies[0]?.content).toContain(`<@${TARGET}>`);
  });

  it('explains when no users are banned', async () => {
    const f = build();
    f.blocked.clear();
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.sink.editReplies.at(-1)).toEqual(
      expect.objectContaining({
        content: 'replies:thread_moderation.list_empty',
      }),
    );
  });

  it('starts long lists at page one with navigation controls', async () => {
    const f = build();
    const users = Array.from({ length: 21 }, (_, i) => String(100000000000000010n + BigInt(i)));
    f.blocked.clear();
    for (const user of users) f.blocked.add(user);
    await new ThreadList().execute(f.interaction, f.bot);
    const reply = f.sink.editReplies[0];
    expect(reply?.content).toContain(users[19]);
    expect(reply?.content).not.toContain(users[20]);
    const row = reply?.components?.[0] as ActionRowBuilder<ButtonBuilder>;
    expect(row.toJSON().components).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: false }),
      expect.objectContaining({ disabled: false, custom_id: `thread_list|${OWNER}|thread|2` }),
    ]);
    expect(f.getInteger).not.toHaveBeenCalled();
  });

  it('allows a delegated manager to list restrictions', async () => {
    const f = build({ actor: OTHER });
    f.isManager.mockResolvedValue(ok(true));
    await new ThreadList().execute(f.interaction, f.bot);
    expect(f.isManager).toHaveBeenCalledWith('this-bot', 'thread', OTHER);
    expect(f.listBlocked).toHaveBeenCalledOnce();
    expect(f.sink.editReplies[0]?.content).toContain(`<@${TARGET}>`);
  });

  it('lets a delegated manager ban and restore other users', async () => {
    const f = build({ actor: OTHER });
    f.blocked.clear();
    f.isManager.mockImplementation(async (_botId, _threadId, userId) => ok(userId === OTHER));
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'banned');
    expect([...f.blocked]).toEqual([TARGET]);
    await new ThreadAllow().execute(f.interaction, f.bot);
    expectReply(f, 'allowed');
    expect(f.blocked.size).toBe(0);
    expect(f.setBlocked.mock.calls).toEqual([
      ['this-bot', 'thread', [TARGET], true, OTHER],
      ['this-bot', 'thread', [TARGET], false, OTHER],
    ]);
  });

  it.each([ThreadBan, ThreadAllow])(
    'does not report success when a delegate loses authority before the atomic write (%s)',
    async (Handler) => {
      const f = build({ actor: OTHER });
      f.bot.translator = echoTranslatorWithParams();
      f.isManager.mockImplementation(async (_botId, _threadId, userId) => ok(userId === OTHER));
      f.setBlocked.mockResolvedValue(dbErr('Manager authority revoked'));
      await new Handler().execute(f.interaction, f.bot);
      expect(f.setBlocked).toHaveBeenCalledWith(
        'this-bot',
        'thread',
        [TARGET],
        Handler === ThreadBan,
        OTHER,
      );
      expect(f.sink.editReplies.at(-1)).toEqual({
        content: expect.stringMatching(/^replies:thread_moderation.failed:.*traceId/u),
      });
      expect(f.logger.error).toHaveBeenCalledOnce();
    },
  );

  it('does not ban users when their protected status cannot be read', async () => {
    const f = build();
    f.isManager.mockResolvedValue(dbErr('Manager lookup failed'));
    await new ThreadBan().execute(f.interaction, f.bot);
    expect(f.setBlocked).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('does not ban a delegated manager', async () => {
    const f = build();
    f.isManager.mockResolvedValue(ok(true));
    await new ThreadBan().execute(f.interaction, f.bot);
    expectReply(f, 'protected_user');
    expect(f.setBlocked).not.toHaveBeenCalled();
  });

  it('reports storage errors with a trace ID instead of claiming the list is empty', async () => {
    const f = build();
    f.bot.translator = echoTranslatorWithParams();
    f.listBlocked.mockResolvedValue(dbErr('Read failed'));
    await new ThreadList().execute(f.interaction, f.bot);
    const content = f.sink.editReplies[0]?.content ?? '';
    const match = /^replies:thread_moderation\.list_failed:\{"traceId":"([a-z0-9]{6})"\}$/u.exec(
      content,
    );
    expect(match).not.toBeNull();
    expect(content).not.toContain(TARGET);
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining(`traceId=${match?.[1]}`));
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
});
