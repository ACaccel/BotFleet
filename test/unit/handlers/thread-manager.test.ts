import { describe, expect, it, vi } from 'vitest';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import Thread from '../../../src/handlers/commands/thread';
import { ok } from '../../../src/core/result';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const ADMIN = '100000000000000001';
const OWNER = '100000000000000002';
const TARGET = '100000000000000003';
const DELEGATE = '100000000000000004';
const THREAD = '100000000000000005';
const BOT = '100000000000000006';
const GUILD = '100000000000000007';

interface BuildOptions {
  readonly actor?: string;
  readonly target?: string;
  readonly page?: number;
  readonly moderationEnabled?: boolean;
  /** Echo the interpolation params, for replies that carry them. */
  readonly withParams?: boolean;
  /** Managers already granted on the thread. */
  readonly managers?: readonly string[];
}

const build = (action = 'add', opts: BuildOptions = {}) => {
  // The repo mocks run over this set, so a test reads back who ended up
  // a manager rather than which repo method was called.
  const managers = new Set<string>(opts.managers ?? []);
  const setManager = vi.fn(
    async (
      _bot: string,
      _thread: string,
      user: string,
      _actor: string,
      enabled: boolean,
      _at: number,
    ) => {
      if (enabled) managers.add(user);
      else managers.delete(user);
      return ok(undefined);
    },
  );
  const isManager = vi.fn(async (_bot: string, _thread: string, user: string) =>
    ok(managers.has(user)),
  );
  const listManagers = vi.fn(async () => ok([...managers]));
  const fetchMember = vi.fn().mockResolvedValue({ user: { id: TARGET, bot: false } });
  const fetchMembership = vi.fn().mockResolvedValue({ id: TARGET });
  const has = vi.fn().mockReturnValue(true);
  const thread = {
    id: THREAD,
    ownerId: OWNER,
    guildId: GUILD,
    type: ChannelType.PublicThread,
    guild: { members: { fetch: fetchMember } },
    isThread: vi.fn().mockReturnValue(true),
    permissionsFor: () => ({ has }),
    members: { fetch: fetchMembership },
  };
  const fetchThread = vi.fn().mockResolvedValue(thread);
  const getRepos = vi
    .fn()
    .mockReturnValue({ threadModeration: { setManager, isManager, listManagers } });
  const { bot, logger } = buildFakeBot({
    clientId: BOT,
    threadModerationEnabled: opts.moderationEnabled ?? true,
    isAdmin: (id: string) => id === ADMIN,
    getRepos,
    ...(opts.withParams === true ? { translator: echoTranslatorWithParams() } : {}),
  });
  const guild = buildGuild({ id: GUILD });
  Object.assign(guild.channels, { fetch: fetchThread });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: opts.actor ?? ADMIN,
    guild,
    channels: { thread: { id: THREAD } },
    users: { user: { id: opts.target ?? TARGET, displayName: 'target' } },
    options: opts.page === undefined ? {} : { page: opts.page },
    subcommand: action,
    subcommandGroup: 'manager',
    sink,
  });
  return {
    bot,
    logger,
    thread,
    sink,
    managers,
    getRepos,
    fetchMember,
    fetchMembership,
    fetchThread,
    has,
    setManager,
    isManager,
    listManagers,
    interaction,
  };
};

const run = async (f: ReturnType<typeof build>): Promise<void> => {
  await new Thread().execute(f.interaction, f.bot);
};

const expectReply = (f: ReturnType<typeof build>, key: string): void => {
  expect(f.sink.editReplies.at(-1)).toEqual({
    content: `replies:thread_moderation.${key}`,
    allowedMentions: { parse: [] },
  });
};

describe('/thread manager', () => {
  it('lets a configured admin grant an accessible member management of only the selected bot and thread', async () => {
    const f = build();
    await run(f);
    expect(f.sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(f.fetchThread).toHaveBeenCalledWith(THREAD, { force: true });
    expect(f.getRepos).toHaveBeenCalledWith(GUILD);
    expect(f.fetchMember).toHaveBeenCalledWith({ user: TARGET, force: true });
    expect(f.has).toHaveBeenCalledWith(PermissionFlagsBits.ViewChannel);
    expect(f.setManager).toHaveBeenCalledWith(BOT, THREAD, TARGET, ADMIN, true, expect.any(Number));
    expect([...f.managers]).toEqual([TARGET]);
    expectReply(f, 'manager_added');
  });

  it.each([OWNER, DELEGATE])(
    'denies non-admin %s even when they manage the thread',
    async (actor) => {
      const f = build('add', { actor, managers: [actor] });
      await run(f);
      expectReply(f, 'manager_admin_only');
      expect(f.fetchThread).not.toHaveBeenCalled();
      expect([...f.managers]).toEqual([actor]);
      expect(f.setManager).not.toHaveBeenCalled();
      expect(f.listManagers).not.toHaveBeenCalled();
    },
  );

  it.each([OWNER, ADMIN, DELEGATE])('does not duplicate authority for %s', async (userId) => {
    const f = build('add', { target: userId, managers: userId === DELEGATE ? [DELEGATE] : [] });
    await run(f);
    expectReply(f, 'manager_already');
    expect(f.setManager).not.toHaveBeenCalled();
    expect(f.managers.has(OWNER) || f.managers.has(ADMIN)).toBe(false);
  });

  it('refuses bot accounts', async () => {
    const f = build();
    f.fetchMember.mockResolvedValue({ user: { id: TARGET, bot: true } });
    await run(f);
    expectReply(f, 'protected_user');
    expect(f.managers.size).toBe(0);
  });

  it.each(['not-thread', 'other-guild', 'missing'])('rejects a %s target', async (kind) => {
    const f = build();
    if (kind === 'not-thread') f.thread.isThread.mockReturnValue(false);
    if (kind === 'other-guild') f.thread.guildId = 'another-guild';
    if (kind === 'missing') f.fetchThread.mockResolvedValue(null);
    await run(f);
    expectReply(f, 'thread_only');
    expect(f.managers.size).toBe(0);
  });

  it('rejects applicants without channel visibility', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    await run(f);
    expectReply(f, 'claim_no_access');
    expect(f.managers.size).toBe(0);
  });

  it('requires membership before granting access to a private thread', async () => {
    const f = build();
    f.thread.type = ChannelType.PrivateThread;
    f.has.mockImplementation(
      (permission: bigint) => permission === PermissionFlagsBits.ViewChannel,
    );
    await run(f);
    expect(f.fetchMembership).toHaveBeenCalledWith(TARGET);
    expect([...f.managers]).toEqual([TARGET]);
    expectReply(f, 'manager_added');
  });

  it('rejects a private thread applicant whose membership cannot be confirmed', async () => {
    const f = build();
    f.thread.type = ChannelType.PrivateThread;
    f.has.mockImplementation(
      (permission: bigint) => permission === PermissionFlagsBits.ViewChannel,
    );
    f.fetchMembership.mockResolvedValue({ id: DELEGATE });
    await run(f);
    expectReply(f, 'claim_no_access');
    expect(f.managers.size).toBe(0);
  });

  it('accepts private thread visibility through ManageThreads without explicit membership', async () => {
    const f = build();
    f.thread.type = ChannelType.PrivateThread;
    await run(f);
    expect(f.fetchMembership).not.toHaveBeenCalled();
    expect([...f.managers]).toEqual([TARGET]);
    expectReply(f, 'manager_added');
  });

  it('does not grant authority to a departed member', async () => {
    const f = build();
    f.fetchMember.mockRejectedValue({ code: 10007 });
    await run(f);
    expect(f.managers.size).toBe(0);
    expect(f.logger.error).toHaveBeenCalledOnce();
    expect(f.sink.editReplies).toHaveLength(1);
  });

  it('revokes a departed member without checking membership or visibility', async () => {
    const f = build('remove', { managers: [TARGET] });
    f.fetchMember.mockRejectedValue({ code: 10007 });
    f.has.mockReturnValue(false);
    await run(f);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.isManager).not.toHaveBeenCalled();
    expect(f.setManager).toHaveBeenCalledWith(
      BOT,
      THREAD,
      TARGET,
      ADMIN,
      false,
      expect.any(Number),
    );
    expect(f.managers.has(TARGET)).toBe(false);
    expectReply(f, 'manager_removed');
  });

  it.each([1, 2])(
    'privately lists sorted managers on page %s without pinging them',
    async (page) => {
      const users = Array.from({ length: 21 }, (_, i) => String(100000000000000010n + BigInt(i)));
      const f = build('list', { page, withParams: true, managers: [...users].reverse() });
      await run(f);
      expect(f.listManagers).toHaveBeenCalledWith(BOT, THREAD);
      expect(f.sink.editReplies.at(-1)).toEqual({
        content: [
          `replies:thread_moderation.manager_list:${JSON.stringify({ count: 21, page, pages: 2 })}`,
          ...users.slice((page - 1) * 20, page * 20).map((id) => `<@${id}> (\`${id}\`)`),
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
      expect(f.fetchMember).not.toHaveBeenCalled();
      expect(f.managers.size).toBe(21);
      expect(f.setManager).not.toHaveBeenCalled();
    },
  );

  it('explains an empty manager list', async () => {
    const f = build('list');
    await run(f);
    expectReply(f, 'manager_empty');
  });

  it.each([0, 2, 1.5])('rejects invalid manager page %s', async (page) => {
    const f = build('list', { page, managers: [TARGET] });
    await run(f);
    expectReply(f, 'list_invalid_page');
  });

  it.each(['add', 'remove', 'list'])(
    'reports database errors for %s without success',
    async (action) => {
      const f = build(action, { withParams: true });
      const failure = { ok: false, error: new Error('Storage failure') };
      f.setManager.mockResolvedValue(failure as never);
      f.listManagers.mockResolvedValue(failure as never);
      await run(f);
      expect(f.logger.error).toHaveBeenCalledOnce();
      expect(f.sink.editReplies).toEqual([
        { content: expect.stringMatching(/^replies:thread_moderation.claim_failed:.*traceId/u) },
      ]);
      expect(f.managers.size).toBe(0);
    },
  );

  it('fails closed when existing management cannot be read', async () => {
    const f = build();
    f.isManager.mockResolvedValue({ ok: false, error: new Error('Lookup failure') } as never);
    await run(f);
    expect(f.managers.size).toBe(0);
    expect(f.logger.error).toHaveBeenCalledOnce();
    expect(f.sink.editReplies).toHaveLength(1);
  });

  it('rejects disabled moderation', async () => {
    const f = build('add', { moderationEnabled: false });
    await run(f);
    expectReply(f, 'disabled');
    expect(f.managers.size).toBe(0);
  });

  it('reports unavailable storage', async () => {
    const f = build();
    f.getRepos.mockReturnValue(undefined);
    await run(f);
    expectReply(f, 'unavailable');
    expect(f.managers.size).toBe(0);
  });
});
