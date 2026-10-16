import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import ClaimCommand from '../../../src/handlers/commands/thread_claim/action';
import ClaimButton from '../../../src/handlers/buttons/thread_claim';
import { buildThreadClaimCard } from '../../../src/handlers/thread-claim-view';
import type { ThreadClaim } from '../../../src/persistence/repositories/thread-moderation.repo';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const BOT = '100000000000000001';
const GUILD = '100000000000000002';
const THREAD = '100000000000000003';
const OWNER = '100000000000000004';
const APPLICANT = '100000000000000005';
const ADMIN = '100000000000000006';
const OTHER_ADMIN = '100000000000000007';
const CLAIM = '0123456789abcdef01234567';
const NOW = Date.UTC(2026, 0, 15, 12);

// Only Date is faked: expiry checks and recorded timestamps read one
// fixed instant, while discord.js fakes keep their real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

const build = () => {
  const claim: { -readonly [Key in keyof ThreadClaim]: ThreadClaim[Key] } = {
    id: CLAIM,
    applicant_id: APPLICANT,
    owner_id: OWNER,
    reason: 'Lost access to my original account',
    requested_at: NOW,
    expires_at: NOW + 86400_000,
    status: 'pending',
    delivery_completed_at: NOW,
    notices: [{ admin_id: ADMIN, channel_id: 'dm', message_id: 'message' }],
  };
  const repo = {
    isManager: vi.fn().mockResolvedValue({ ok: true, value: false }),
    createClaim: vi.fn().mockResolvedValue({ ok: true, value: 'created' }),
    bindClaimNotices: vi.fn().mockResolvedValue({ ok: true, value: true }),
    completeClaimDelivery: vi.fn().mockResolvedValue({ ok: true, value: true }),
    failClaimDelivery: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    findClaim: vi.fn().mockImplementation(async () => ({ ok: true, value: claim })),
    decideClaim: vi.fn().mockImplementation(async (...args: unknown[]) => {
      claim.status = args[6] ? 'approved' : 'rejected';
      return { ok: true, value: true };
    }),
  };
  const fetchMember = vi.fn().mockResolvedValue({ user: { id: APPLICANT, bot: false } });
  const has = vi.fn().mockReturnValue(true);
  const membership = vi.fn().mockResolvedValue({ id: APPLICANT });
  const fetchChannel = vi.fn();
  const threadSend = vi.fn().mockResolvedValue(undefined);
  const guild = buildGuild({ id: GUILD });
  Object.assign(guild.members, { fetch: fetchMember });
  Object.assign(guild.channels, { fetch: fetchChannel });
  const thread = {
    id: THREAD,
    guildId: GUILD,
    guild,
    ownerId: OWNER as string | null,
    type: ChannelType.PublicThread,
    isThread: () => true,
    permissionsFor: () => ({ has }),
    members: { fetch: membership },
    send: threadSend,
  };
  fetchChannel.mockResolvedValue(thread);
  const message = { id: 'message', channelId: 'dm', edit: vi.fn().mockResolvedValue(undefined) };
  const send = vi.fn().mockResolvedValue(message);
  const createDM = vi
    .fn()
    .mockResolvedValue({ id: 'dm', messages: { fetch: vi.fn().mockResolvedValue(message) } });
  const fetchUser = vi.fn().mockResolvedValue({ send, createDM });
  const fetchGuild = vi.fn().mockResolvedValue(guild);
  const getRepos = vi
    .fn()
    .mockImplementation((id: string) => (id === GUILD ? { threadModeration: repo } : undefined));
  const { bot, logger } = buildFakeBot({
    clientId: BOT,
    threadModerationEnabled: true,
    adminIds: [ADMIN, OTHER_ADMIN],
    isAdmin: (id: string) => [ADMIN, OTHER_ADMIN].includes(id),
    getRepos,
    client: { users: { fetch: fetchUser }, guilds: { fetch: fetchGuild } },
  });
  const commandSink = newInteractionSink();
  const command = buildChatInputInteraction({
    userId: APPLICANT,
    guild,
    channels: { thread: { id: THREAD } },
    options: { reason: claim.reason },
    sink: commandSink,
  });
  const buttonSink = newInteractionSink();
  const button = buildButtonInteraction({
    customId: `thread_claim|approve|${GUILD}|${THREAD}|${CLAIM}`,
    userId: ADMIN,
    guildId: null,
    sink: buttonSink,
  });
  // The button builder has no `deferReply`, channel or message surface;
  // the handler binds the review to the DM message it was sent on.
  Object.assign(button, {
    channelId: 'dm',
    message: { id: 'message', author: { id: BOT } },
    deferReply: async (opts?: { flags?: number }) => {
      buttonSink.defers.push(opts ?? {});
      buttonSink.acknowledged.deferred = true;
    },
  });
  return {
    bot,
    logger,
    repo,
    claim,
    command,
    commandSink,
    button,
    buttonSink,
    thread,
    fetchChannel,
    has,
    fetchMember,
    membership,
    fetchUser,
    fetchGuild,
    send,
    threadSend,
    message,
    createDM,
    getRepos,
    execute: () => new ClaimCommand().execute(command, bot),
    review: () => new ClaimButton().execute(button, bot),
  };
};

const expectReply = (sink: ReturnType<typeof newInteractionSink>, key: string) => {
  expect(sink.editReplies.at(-1)).toEqual({
    content: `replies:thread_moderation.${key}`,
    allowedMentions: { parse: [] },
  });
};

describe('thread claim card status', () => {
  it.each([
    ['pending', 86400_000, true, 'pending', 0xfee75c, false],
    ['pending', 86400_000, false, 'pending', 0xfee75c, true],
    ['pending', -1000, true, 'expired', 0x99aab5, true],
    ['approved', 86400_000, true, 'approved', 0x57f287, true],
    ['approved', -1000, true, 'approved', 0x57f287, true],
    ['rejected', 86400_000, true, 'rejected', 0x99aab5, true],
    ['delivery_failed', 86400_000, true, 'delivery_failed', 0xed4245, true],
  ] as const)(
    'renders %s with expiry offset %i and enabled=%s',
    (status, expiryOffset, enabled, displayedStatus, color, disabled) => {
      const f = build();
      const card = buildThreadClaimCard(
        f.bot,
        GUILD,
        THREAD,
        { ...f.claim, status, expires_at: NOW + expiryOffset },
        enabled,
      );
      const embed = card.embeds[0]!.toJSON();
      expect(embed.color).toBe(color);
      expect(embed.fields).toContainEqual({
        name: 'replies:thread_moderation.claim_status',
        value: `replies:thread_moderation.claim_status_${displayedStatus}`,
      });
      expect(card.components[0]!.toJSON().components.map((button) => button.disabled)).toEqual([
        disabled,
        disabled,
      ]);
    },
  );
});

describe('thread_claim submission', () => {
  it('renders a maximum-length Markdown reason without exceeding embed limits', async () => {
    const f = build();
    const reason = '*'.repeat(1000);
    Object.assign(f.command.options, { getString: () => reason });
    const card = buildThreadClaimCard(f.bot, GUILD, THREAD, { ...f.claim, reason }, false);
    expect(() => card.embeds[0]!.toJSON()).not.toThrow();
    expect(card.embeds[0]!.toJSON().description!.replaceAll('\\', '')).toContain(reason);
    expect(card.embeds[0]!.toJSON().description!.length).toBeGreaterThan(1024);
    expect(card.embeds[0]!.toJSON().description!.length).toBeLessThanOrEqual(4096);
    await f.execute();
    expectReply(f.commandSink, 'claim_submitted');
  });

  it('sends disabled cards to every distinct admin, persists bindings, then enables them', async () => {
    const f = build();
    Object.defineProperty(f.bot, 'adminIds', { value: [ADMIN, OTHER_ADMIN, ADMIN] });
    f.send.mockImplementation(async (card) => {
      expect(
        card.components[0]
          .toJSON()
          .components.every((button: { disabled: boolean }) => button.disabled),
      ).toBe(true);
      expect(f.repo.bindClaimNotices).not.toHaveBeenCalled();
      return f.message;
    });
    f.message.edit.mockImplementation(async (card) => {
      expect(f.repo.bindClaimNotices).toHaveBeenCalledOnce();
      expect(f.repo.completeClaimDelivery).not.toHaveBeenCalled();
      expect(
        card.components[0]
          .toJSON()
          .components.every((button: { disabled: boolean }) => !button.disabled),
      ).toBe(true);
    });
    f.repo.completeClaimDelivery.mockImplementation(async () => {
      expect(f.message.edit).toHaveBeenCalledTimes(2);
      expect(f.commandSink.editReplies).toEqual([]);
      return { ok: true, value: true };
    });
    await f.execute();
    expect(f.repo.completeClaimDelivery).toHaveBeenCalledWith(BOT, THREAD, expect.any(String), NOW);
    expect(f.fetchUser.mock.calls.map(([id]) => id)).toEqual([ADMIN, OTHER_ADMIN]);
    expect(f.repo.createClaim).toHaveBeenCalledWith(
      BOT,
      THREAD,
      expect.objectContaining({
        applicant_id: APPLICANT,
        owner_id: OWNER,
        status: 'pending',
        requested_at: NOW,
        expires_at: NOW + 7 * 86400_000,
      }),
    );
    expect(f.repo.bindClaimNotices).toHaveBeenCalledWith(BOT, THREAD, expect.any(String), [
      expect.objectContaining({ admin_id: ADMIN }),
      expect.objectContaining({ admin_id: OTHER_ADMIN }),
    ]);
    expectReply(f.commandSink, 'claim_submitted');
  });

  it('succeeds if at least one admin can receive and enable a card', async () => {
    const f = build();
    f.fetchUser.mockRejectedValueOnce(new Error('DM closed'));
    await f.execute();
    expectReply(f.commandSink, 'claim_submitted');
    expect(f.repo.failClaimDelivery).not.toHaveBeenCalled();
  });

  it.each(['closed', 'bind', 'enable'])(
    'fails safely when delivery stage %s fails',
    async (stage) => {
      const f = build();
      if (stage === 'closed') f.send.mockRejectedValue(new Error('DM closed'));
      if (stage === 'bind') f.repo.bindClaimNotices.mockResolvedValue({ ok: true, value: false });
      if (stage === 'enable') f.message.edit.mockRejectedValue(new Error('Cannot edit'));
      await f.execute();
      expectReply(f.commandSink, 'claim_delivery_failed');
      expect(f.repo.failClaimDelivery).toHaveBeenCalledWith(BOT, THREAD, expect.any(String));
      if (stage !== 'closed') expect(f.message.edit).toHaveBeenLastCalledWith({ components: [] });
    },
  );

  it.each(['duplicate', 'cooldown'])('does not resend a %s request', async (status) => {
    const f = build();
    f.repo.createClaim.mockResolvedValue({ ok: true, value: status });
    await f.execute();
    expectReply(f.commandSink, `claim_${status}`);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['expired', 'error'])(
    'does not report success when delivery completion fails: %s',
    async (scenario) => {
      const f = build();
      if (scenario === 'expired')
        f.repo.completeClaimDelivery.mockResolvedValue({ ok: true, value: false });
      else
        f.repo.completeClaimDelivery.mockResolvedValue({
          ok: false,
          error: new Error('Completion write failed'),
        });
      await f.execute();
      expect(f.repo.completeClaimDelivery).toHaveBeenCalledOnce();
      expect(f.repo.failClaimDelivery).toHaveBeenCalledWith(BOT, THREAD, expect.any(String));
      expect(f.message.edit).toHaveBeenLastCalledWith({ components: [] });
      expect(f.commandSink.editReplies.at(-1)).toEqual(
        expect.objectContaining({
          content: `replies:thread_moderation.${scenario === 'expired' ? 'claim_delivery_failed' : 'claim_failed'}`,
        }),
      );
    },
  );

  it.each([
    'dm',
    'foreign',
    'nonthread',
    'owner',
    'manager',
    'no-access',
    'private',
    'bot',
    'reason',
    'missing-owner',
    'no-admins',
  ])('rejects invalid applicant or context: %s', async (scenario) => {
    const f = build();
    const keys: Record<string, string> = {
      dm: 'thread_only',
      foreign: 'thread_only',
      nonthread: 'thread_only',
      owner: 'manager_already',
      manager: 'manager_already',
      'no-access': 'claim_no_access',
      private: 'claim_no_access',
      bot: 'protected_user',
      reason: 'claim_reason_invalid',
      'missing-owner': 'claim_owner_missing',
      'no-admins': 'claim_no_admins',
    };
    if (scenario === 'dm') Object.assign(f.command, { guild: null });
    if (scenario === 'foreign') f.thread.guildId = 'foreign';
    if (scenario === 'nonthread') f.thread.isThread = () => false;
    if (scenario === 'owner') Object.assign(f.command.user, { id: OWNER });
    if (scenario === 'manager') f.repo.isManager.mockResolvedValue({ ok: true, value: true });
    if (scenario === 'no-access') f.has.mockReturnValue(false);
    if (scenario === 'private') {
      f.thread.type = ChannelType.PrivateThread;
      f.has.mockImplementation((permission) => permission === PermissionFlagsBits.ViewChannel);
      f.membership.mockResolvedValue({ id: 'another-member' });
    }
    if (scenario === 'bot') f.fetchMember.mockResolvedValue({ user: { bot: true } });
    if (scenario === 'reason') Object.assign(f.command.options, { getString: () => ' ' });
    if (scenario === 'missing-owner') f.thread.ownerId = null;
    if (scenario === 'no-admins') Object.defineProperty(f.bot, 'adminIds', { value: [] });
    await f.execute();
    expectReply(f.commandSink, keys[scenario]!);
    expect(f.repo.createClaim).not.toHaveBeenCalled();
  });

  it('requires current guild membership and does not create a request on lookup failure', async () => {
    const f = build();
    f.fetchMember.mockRejectedValue(new Error('Unknown member'));
    await f.execute();
    expect(f.fetchMember).toHaveBeenCalledWith({ user: APPLICANT, force: true });
    expect(f.repo.createClaim).not.toHaveBeenCalled();
    expect(f.commandSink.editReplies.at(-1)).toEqual({
      content: 'replies:thread_moderation.claim_failed',
    });
  });
});

describe('thread_claim DM review', () => {
  it('blocks a pending approval when thread management is disabled', async () => {
    const f = build();
    Object.assign(f.bot, { guildSettings: { isEnabled: () => false } });
    await new ClaimButton().execute(f.button, f.bot);
    expect(f.repo.decideClaim).not.toHaveBeenCalled();
    expect(f.claim.status).toBe('pending');
    expect(f.buttonSink.editReplies[0]?.content).toContain('replies:settings.feature_disabled');
  });

  it('keeps rejection available when thread management is disabled', async () => {
    const f = build();
    Object.assign(f.bot, { guildSettings: { isEnabled: () => false } });
    Object.assign(f.button, { customId: f.button.customId.replace('approve', 'reject') });
    await new ClaimButton().execute(f.button, f.bot);
    expect(f.claim.status).toBe('rejected');
    expect(f.repo.decideClaim).toHaveBeenCalledOnce();
  });
  it('does not decide a bound request before delivery has durably completed', async () => {
    const f = build();
    delete f.claim.delivery_completed_at;
    await f.review();
    expectReply(f.buttonSink, 'claim_delivering');
    expect(f.repo.decideClaim).not.toHaveBeenCalled();
    expect(f.fetchGuild).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('reports committed approval without another database read even if notification fails', async () => {
    const f = build();
    f.repo.findClaim
      .mockResolvedValueOnce({ ok: true, value: f.claim })
      .mockRejectedValue(new Error('Read unavailable after commit'));
    f.send.mockRejectedValue(new Error('Applicant DM closed'));
    await f.review();
    expect(f.repo.findClaim).toHaveBeenCalledOnce();
    expect(f.repo.decideClaim).toHaveBeenCalledOnce();
    expectReply(f.buttonSink, 'claim_approved');
    const card = f.message.edit.mock.calls[0]![0];
    expect(card.embeds[0].toJSON().fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'replies:thread_moderation.claim_status',
          value: 'replies:thread_moderation.claim_status_approved',
        }),
        expect.objectContaining({
          name: 'replies:thread_moderation.claim_reviewer',
          value: `<@${ADMIN}>`,
        }),
      ]),
    );
    expect(
      card.components[0]
        .toJSON()
        .components.every((button: { disabled: boolean }) => button.disabled),
    ).toBe(true);
  });

  it('loads durable state in a new handler and atomically approves the exact bound request', async () => {
    const f = build();
    await f.review();
    expect(f.repo.findClaim).toHaveBeenCalledWith(BOT, THREAD, CLAIM);
    expect(f.fetchGuild).toHaveBeenCalledWith(GUILD);
    expect(f.fetchChannel).toHaveBeenCalledWith(THREAD, { force: true });
    expect(f.fetchMember).toHaveBeenCalledWith({ user: APPLICANT, force: true });
    expect(f.repo.decideClaim).toHaveBeenCalledWith(
      BOT,
      THREAD,
      CLAIM,
      ADMIN,
      'dm',
      'message',
      true,
      NOW,
    );
    expectReply(f.buttonSink, 'claim_approved');
    expect(f.send).toHaveBeenCalledWith({
      content: `replies:thread_moderation.claim_applicant_approved\nhttps://discord.com/channels/${GUILD}/${THREAD}`,
      allowedMentions: { parse: [] },
    });
    expect(f.threadSend).not.toHaveBeenCalled();
    await f.review();
    expect(f.repo.decideClaim).toHaveBeenCalledOnce();
    expectReply(f.buttonSink, 'claim_already_reviewed');
  });

  it.each([
    'nonadmin',
    'guild',
    'bot',
    'message',
    'channel',
    'recipient',
    'malformed',
    'foreign-guild',
    'foreign-thread',
    'foreign-claim',
    'expired',
    'decided',
  ])('rejects unauthorized or stale review: %s', async (scenario) => {
    const f = build();
    const customId = f.button.customId;
    if (scenario === 'nonadmin') Object.assign(f.button.user, { id: APPLICANT });
    if (scenario === 'guild') Object.assign(f.button, { guildId: GUILD });
    if (scenario === 'bot') Object.assign(f.button.message.author, { id: 'foreign-bot' });
    if (scenario === 'message') Object.assign(f.button.message, { id: 'copied-message' });
    if (scenario === 'channel') Object.assign(f.button, { channelId: 'foreign-dm' });
    if (scenario === 'recipient') Object.assign(f.button.user, { id: OTHER_ADMIN });
    if (scenario === 'malformed') Object.assign(f.button, { customId: `${customId}|extra` });
    if (scenario === 'foreign-guild') {
      Object.assign(f.button, { customId: customId.replace(GUILD, OWNER) });
    }
    if (scenario === 'foreign-thread' || scenario === 'foreign-claim') {
      f.repo.findClaim.mockImplementation(async (_bot, thread, claim) => ({
        ok: true,
        value: thread === THREAD && claim === CLAIM ? f.claim : undefined,
      }));
      Object.assign(f.button, {
        customId:
          scenario === 'foreign-thread'
            ? customId.replace(THREAD, OWNER)
            : customId.replace(CLAIM, 'abcdefabcdefabcdefabcdef'),
      });
    }
    if (scenario === 'expired') f.claim.expires_at = NOW - 1;
    if (scenario === 'decided') f.claim.status = 'rejected';
    await f.review();
    expect(f.repo.decideClaim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expectReply(
      f.buttonSink,
      scenario === 'nonadmin'
        ? 'manager_admin_only'
        : scenario === 'expired'
          ? 'claim_expired'
          : scenario === 'decided'
            ? 'claim_already_reviewed'
            : scenario === 'foreign-guild'
              ? 'unavailable'
              : 'claim_stale',
    );
  });

  // A lookup that throws (the applicant left the guild or the private
  // thread) is not a ThreadManagementError, so it surfaces as the generic
  // failure reply rather than a specific key.
  it.each([
    ['owner', 'claim_owner_changed'],
    ['access', 'claim_no_access'],
    ['membership', 'claim_failed'],
    ['private', 'claim_failed'],
  ] as const)('rechecks applicant eligibility before approval: %s', async (scenario, key) => {
    const f = build();
    if (scenario === 'owner') f.thread.ownerId = ADMIN;
    if (scenario === 'access') f.has.mockReturnValue(false);
    if (scenario === 'membership') f.fetchMember.mockRejectedValue(new Error('Left guild'));
    if (scenario === 'private') {
      f.thread.type = ChannelType.PrivateThread;
      f.has.mockImplementation((permission) => permission === PermissionFlagsBits.ViewChannel);
      f.membership.mockRejectedValue(new Error('Left private thread'));
    }
    await f.review();
    expect(f.repo.decideClaim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    if (key === 'claim_failed') {
      expect(f.buttonSink.editReplies.at(-1)).toEqual({
        content: 'replies:thread_moderation.claim_failed',
      });
    } else {
      expectReply(f.buttonSink, key);
    }
  });

  it('allows rejection even when the applicant has left the server', async () => {
    const f = build();
    Object.assign(f.button, { customId: f.button.customId.replace('approve', 'reject') });
    f.fetchMember.mockRejectedValue(new Error('Left guild'));
    await f.review();
    expect(f.fetchGuild).not.toHaveBeenCalled();
    expect(f.repo.decideClaim).toHaveBeenCalledWith(
      BOT,
      THREAD,
      CLAIM,
      ADMIN,
      'dm',
      'message',
      false,
      NOW,
    );
    expectReply(f.buttonSink, 'claim_rejected');
    expect(f.send).toHaveBeenCalledWith({
      content: `replies:thread_moderation.claim_applicant_rejected\nhttps://discord.com/channels/${GUILD}/${THREAD}`,
      allowedMentions: { parse: [] },
    });
  });

  it('does not announce approval when another reviewer wins the storage race', async () => {
    const f = build();
    f.repo.decideClaim.mockResolvedValue({ ok: true, value: false });
    await f.review();
    expectReply(f.buttonSink, 'claim_already_reviewed');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.message.edit).not.toHaveBeenCalled();
  });

  it('keeps approval successful when card refresh and applicant notification fail', async () => {
    const f = build();
    f.createDM.mockRejectedValue(new Error('Admin DM unavailable'));
    f.send.mockRejectedValue(new Error('Applicant DM unavailable'));
    await f.review();
    expect(f.claim.status).toBe('approved');
    expect(f.repo.decideClaim).toHaveBeenCalledOnce();
    expect(f.repo.failClaimDelivery).not.toHaveBeenCalled();
    expectReply(f.buttonSink, 'claim_approved');
    expect(f.logger.error).toHaveBeenCalledTimes(2);
  });

  it('mentions the applicant in the thread when the approval DM fails', async () => {
    const f = build();
    f.send.mockRejectedValue(new Error('Applicant DM closed'));
    await f.review();
    expectReply(f.buttonSink, 'claim_approved');
    expect(f.threadSend).toHaveBeenCalledWith({
      content: `<@${APPLICANT}> replies:thread_moderation.claim_applicant_approved`,
      allowedMentions: { users: [APPLICANT] },
    });
  });

  it('keeps approval successful when the thread fallback also fails', async () => {
    const f = build();
    f.send.mockRejectedValue(new Error('Applicant DM closed'));
    f.threadSend.mockRejectedValue(new Error('Thread locked'));
    await f.review();
    expect(f.repo.decideClaim).toHaveBeenCalledOnce();
    expectReply(f.buttonSink, 'claim_approved');
    expect(f.logger.error).toHaveBeenCalledTimes(2);
  });

  it('does not publish a rejection in the thread when the DM fails', async () => {
    const f = build();
    Object.assign(f.button, { customId: f.button.customId.replace('approve', 'reject') });
    f.send.mockRejectedValue(new Error('Applicant DM closed'));
    await f.review();
    expectReply(f.buttonSink, 'claim_rejected');
    expect(f.threadSend).not.toHaveBeenCalled();
  });
});
