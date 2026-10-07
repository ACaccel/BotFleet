import { describe, expect, it, vi } from 'vitest';
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import Thread from '../../../src/handlers/commands/thread';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';

const ADMIN = '100000000000000001';
const OWNER = '100000000000000002';
const TARGET = '100000000000000003';
const DELEGATE = '100000000000000004';
const THREAD = '100000000000000005';
const BOT = '100000000000000006';
const GUILD = '100000000000000007';

const build = (action = 'add') => {
  const setManager = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const isManager = vi.fn().mockResolvedValue({ ok: true, value: false });
  const listManagers = vi.fn().mockResolvedValue({ ok: true, value: [TARGET] });
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
    threadModerationEnabled: true,
    isAdmin: (id: string) => id === ADMIN,
    getRepos,
  });
  const data = {
    user: { id: ADMIN },
    guild: { id: GUILD, channels: { fetch: fetchThread } },
    guildId: GUILD,
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue('manager'),
      getSubcommand: vi.fn().mockReturnValue(action),
      getChannel: vi.fn().mockReturnValue({ id: THREAD }),
      getUser: vi.fn().mockReturnValue({ id: TARGET }),
      getInteger: vi.fn().mockReturnValue(null),
    },
    deferred: true,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return {
    bot,
    logger,
    thread,
    data,
    getRepos,
    fetchMember,
    fetchMembership,
    fetchThread,
    has,
    setManager,
    isManager,
    listManagers,
    interaction: data as unknown as ChatInputCommandInteraction,
  };
};

const run = async (f: ReturnType<typeof build>): Promise<void> => {
  await new Thread().execute(f.interaction, f.bot);
};

const expectReply = (f: ReturnType<typeof build>, key: string): void => {
  expect(f.data.editReply).toHaveBeenLastCalledWith({
    content: `replies:thread_moderation.${key}`,
    allowedMentions: { parse: [] },
  });
};

describe('/thread manager', () => {
  it('lets a configured admin grant an accessible member management of only the selected bot and thread', async () => {
    const f = build();
    await run(f);
    expect(f.data.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.fetchThread).toHaveBeenCalledWith(THREAD, { force: true });
    expect(f.getRepos).toHaveBeenCalledWith(GUILD);
    expect(f.fetchMember).toHaveBeenCalledWith({ user: TARGET, force: true });
    expect(f.has).toHaveBeenCalledWith(PermissionFlagsBits.ViewChannel);
    expect(f.setManager).toHaveBeenCalledWith(BOT, THREAD, TARGET, ADMIN, true, expect.any(Number));
    expectReply(f, 'manager_added');
  });

  it.each([OWNER, DELEGATE])(
    'denies non-admin %s even when they manage the thread',
    async (actor) => {
      const f = build();
      f.data.user.id = actor;
      f.isManager.mockResolvedValue({ ok: true, value: true });
      await run(f);
      expectReply(f, 'manager_admin_only');
      expect(f.fetchThread).not.toHaveBeenCalled();
      expect(f.setManager).not.toHaveBeenCalled();
      expect(f.listManagers).not.toHaveBeenCalled();
    },
  );

  it.each([OWNER, ADMIN, DELEGATE])('does not duplicate authority for %s', async (userId) => {
    const f = build();
    f.data.options.getUser.mockReturnValue({ id: userId });
    if (userId === DELEGATE) f.isManager.mockResolvedValue({ ok: true, value: true });
    await run(f);
    expectReply(f, 'manager_already');
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it('refuses bot accounts', async () => {
    const f = build();
    f.fetchMember.mockResolvedValue({ user: { id: TARGET, bot: true } });
    await run(f);
    expectReply(f, 'protected_user');
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it.each(['not-thread', 'other-guild', 'missing'])('rejects a %s target', async (kind) => {
    const f = build();
    if (kind === 'not-thread') f.thread.isThread.mockReturnValue(false);
    if (kind === 'other-guild') f.thread.guildId = 'another-guild';
    if (kind === 'missing') f.fetchThread.mockResolvedValue(null);
    await run(f);
    expectReply(f, 'thread_only');
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it('rejects applicants without channel visibility', async () => {
    const f = build();
    f.has.mockReturnValue(false);
    await run(f);
    expectReply(f, 'claim_no_access');
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it('requires membership before granting access to a private thread', async () => {
    const f = build();
    f.thread.type = ChannelType.PrivateThread;
    f.has.mockImplementation(
      (permission: bigint) => permission === PermissionFlagsBits.ViewChannel,
    );
    await run(f);
    expect(f.fetchMembership).toHaveBeenCalledWith(TARGET);
    expect(f.setManager).toHaveBeenCalledOnce();
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
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it('accepts private thread visibility through ManageThreads without explicit membership', async () => {
    const f = build();
    f.thread.type = ChannelType.PrivateThread;
    await run(f);
    expect(f.fetchMembership).not.toHaveBeenCalled();
    expect(f.setManager).toHaveBeenCalledOnce();
  });

  it('does not grant authority to a departed member', async () => {
    const f = build();
    f.fetchMember.mockRejectedValue({ code: 10007 });
    await run(f);
    expect(f.setManager).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('revokes a departed member without checking membership or visibility', async () => {
    const f = build('remove');
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
    expectReply(f, 'manager_removed');
  });

  it.each([1, 2])(
    'privately lists sorted managers on page %s without pinging them',
    async (page) => {
      const f = build('list');
      const users = Array.from({ length: 21 }, (_, i) => String(100000000000000010n + BigInt(i)));
      f.listManagers.mockResolvedValue({ ok: true, value: [...users].reverse() });
      f.data.options.getInteger.mockReturnValue(page);
      f.bot.translator = echoTranslatorWithParams();
      await run(f);
      expect(f.listManagers).toHaveBeenCalledWith(BOT, THREAD);
      expect(f.data.editReply).toHaveBeenLastCalledWith({
        content: [
          `replies:thread_moderation.manager_list:${JSON.stringify({ count: 21, page, pages: 2 })}`,
          ...users.slice((page - 1) * 20, page * 20).map((id) => `<@${id}> (\`${id}\`)`),
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
      expect(f.fetchMember).not.toHaveBeenCalled();
      expect(f.setManager).not.toHaveBeenCalled();
    },
  );

  it('explains an empty manager list', async () => {
    const f = build('list');
    f.listManagers.mockResolvedValue({ ok: true, value: [] });
    await run(f);
    expectReply(f, 'manager_empty');
  });

  it.each([0, 2, 1.5])('rejects invalid manager page %s', async (page) => {
    const f = build('list');
    f.data.options.getInteger.mockReturnValue(page);
    await run(f);
    expectReply(f, 'list_invalid_page');
  });

  it.each(['add', 'remove', 'list'])(
    'reports database errors for %s without success',
    async (action) => {
      const f = build(action);
      f.bot.translator = echoTranslatorWithParams();
      const failure = { ok: false, error: new Error('Storage failure') };
      f.setManager.mockResolvedValue(failure);
      f.listManagers.mockResolvedValue(failure);
      await run(f);
      expect(f.logger.error).toHaveBeenCalledOnce();
      expect(f.data.editReply).toHaveBeenLastCalledWith({
        content: expect.stringMatching(/^replies:thread_moderation.claim_failed:.*traceId/u),
      });
    },
  );

  it('fails closed when existing management cannot be read', async () => {
    const f = build();
    f.isManager.mockResolvedValue({ ok: false, error: new Error('Lookup failure') });
    await run(f);
    expect(f.setManager).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('rejects disabled moderation', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'threadModerationEnabled', { value: false });
    await run(f);
    expectReply(f, 'disabled');
    expect(f.setManager).not.toHaveBeenCalled();
  });

  it('reports unavailable storage', async () => {
    const f = build();
    f.getRepos.mockReturnValue(undefined);
    await run(f);
    expectReply(f, 'unavailable');
    expect(f.setManager).not.toHaveBeenCalled();
  });
});
