/**
 * `/ban_user` failure handling.
 *
 * Three failures used to vanish: a rejected `member.timeout` was caught
 * by a bare `catch {}`, the scheduled judgement's rejection escaped as a
 * detached `unhandledRejection`, and the fallback message-deleting
 * listener's removal timer held the event loop open during shutdown.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collection } from 'discord.js';
import {
  defaultGuildSettings,
  FEATURES,
  type GuildSettings,
  type OperatorCapabilities,
} from '../../../../src/core/guild-settings';

const scheduledCallbacks: Array<() => void> = [];
vi.mock('node-schedule', () => ({
  default: {
    scheduleJob: (_when: unknown, cb: () => void) => {
      scheduledCallbacks.push(cb);
      return { cancel: vi.fn() };
    },
  },
}));

import BanUser from '../../../../src/handlers/commands/ban_user';
import { echoTranslator } from '../../../fixtures/runtime';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const GUILD_ID = 'g1';
const TARGET_ID = 'u-target';

interface Fixture {
  /** Reaction count reported on the judgement message (excludes the bot's own). */
  readonly votes: number;
  /** Whether `member.timeout` resolves. */
  readonly timeoutSucceeds: boolean;
  readonly targetIsBot?: boolean;
  /** The guild's configured voter role; `null` leaves it unset. */
  readonly voterRoleId?: string | null;
  readonly settings?: GuildSettings;
  readonly moderatable?: boolean;
}

const build = (fixture: Fixture) => {
  const reply = vi.fn(async () => undefined);
  const judgeMessage = {
    reactions: {
      resolve: () => ({
        count: fixture.votes + 1,
        users: {
          fetch: vi.fn(
            async () => new Collection([['eligible-voter', { id: 'eligible-voter', bot: false }]]),
          ),
        },
      }),
    },
    reply,
    react: vi.fn(async () => undefined),
    id: 'judge-1',
    guildId: GUILD_ID,
  };
  const member = buildGuildMember({
    id: TARGET_ID,
    displayName: 'Target',
    bot: fixture.targetIsBot ?? false,
  });
  const timeout = vi.fn(async () => {
    if (!fixture.timeoutSucceeds) throw new Error('Missing Permissions');
  });
  Object.assign(member, { timeout, moderatable: fixture.moderatable ?? true });
  Object.assign(member.user, { tag: 'target#1' });
  const clientListeners = new Map<string, unknown>();
  const send = vi.fn(async (_options: unknown) => judgeMessage);
  const { bot, logger } = buildFakeBot({
    client: {
      prependListener: (event: string, fn: unknown) => clientListeners.set(event, fn),
      off: (event: string) => clientListeners.delete(event),
    },
    ...(fixture.settings
      ? {
          guildSettings: {
            get: () => ({ settings: fixture.settings }),
            isEnabled: vi.fn(() => true),
          },
        }
      : {}),
    getGuildInfo: () =>
      fixture.voterRoleId === null
        ? { roles: {} }
        : { roles: { ban_user: { id: fixture.voterRoleId ?? 'role-1' } } },
  });

  const channel = { id: 'c1', isSendable: () => true, send };
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: 'u-init',
    username: 'initiator',
    member: buildGuildMember({ id: 'u-init', displayName: 'Initiator' }),
    guild: buildGuild({ id: GUILD_ID, members: [member] }),
    channel,
    options: { user: TARGET_ID },
    sink,
  });
  if (fixture.settings) {
    interaction.guild!.members.fetch = vi
      .fn()
      .mockImplementation(async ({ user }: { user: string }) =>
        user === TARGET_ID ? member : buildGuildMember({ id: user, roleIds: ['voter-role'] }),
      );
  }
  return {
    bot,
    interaction,
    sink,
    member,
    timeout,
    reply,
    send,
    error: logger.error,
    clientListeners,
    judgeMessage,
  };
};

afterEach(() => {
  scheduledCallbacks.length = 0;
  vi.clearAllMocks();
});

describe('ban_user judgement', () => {
  it('times the target out when the vote threshold is met', async () => {
    const { bot, interaction, timeout, reply, sink } = build({
      votes: 5,
      timeoutSucceeds: true,
    });

    await new BanUser().execute(interaction, bot);
    expect(scheduledCallbacks).toHaveLength(1);
    // The invoking acknowledgement is replaced by the public vote message.
    expect(sink.defers).toEqual([{}]);
    expect(sink.deletes).toEqual(['@original']);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledTimes(1));

    expect(reply).toHaveBeenCalledWith('replies:ban_user.timed_out');
  });

  it('logs the reason when the timeout is refused, then falls back', async () => {
    const { bot, interaction, reply, error, clientListeners } = build({
      votes: 5,
      timeoutSucceeds: false,
    });

    await new BanUser().execute(interaction, bot);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.cannot_timeout'));

    // A bare `catch {}` used to hide whether this was a missing
    // permission or a role-hierarchy problem.
    expect(error).toHaveBeenCalled();
    // ...and the fallback listener is installed.
    expect(clientListeners.size).toBe(1);
  });

  it('reports a vote that fell short without timing anyone out', async () => {
    const { bot, interaction, timeout, reply } = build({ votes: 1, timeoutSucceeds: true });

    await new BanUser().execute(interaction, bot);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.vote_failed'));

    expect(timeout).not.toHaveBeenCalled();
  });

  it('routes a rejected judgement to the logger rather than an unhandled rejection', async () => {
    const { bot, interaction, error } = build({ votes: 5, timeoutSucceeds: true });
    await new BanUser().execute(interaction, bot);

    // node-schedule discards the value its callback returns, so without
    // the wrapper the rejection had no path back to this vote.
    bot.translator = {
      ...echoTranslator(),
      t: () => {
        throw new Error('catalog exploded');
      },
    };
    expect(() => scheduledCallbacks[0]?.()).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});

describe('ban_user vote call', () => {
  it('refuses a bot target before any vote is posted', async () => {
    const { bot, interaction, send, sink } = build({
      votes: 5,
      timeoutSucceeds: true,
      targetIsBot: true,
    });

    await new BanUser().execute(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'replies:ban_user.cannot_ban_bot' }]);
    expect(sink.deletes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(scheduledCallbacks).toHaveLength(0);
  });

  it('pings only the configured voter role', async () => {
    const { bot, interaction, send } = build({ votes: 0, timeoutSucceeds: true });

    await new BanUser().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: 'replies:ban_user.vote_call\nreplies:ban_user.vote_ping',
      allowedMentions: { roles: ['role-1'] },
    });
  });

  it('pings nobody when no voter role is configured', async () => {
    const { bot, interaction, send } = build({
      votes: 0,
      timeoutSucceeds: true,
      voterRoleId: null,
    });

    await new BanUser().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: 'replies:ban_user.vote_call',
      allowedMentions: { parse: [] },
    });
  });
});

const guildSettings = (): GuildSettings => {
  const capabilities: OperatorCapabilities = {
    features: Object.fromEntries(
      FEATURES.map((name) => [name, true]),
    ) as OperatorCapabilities['features'],
    socialProviders: [],
    maxRandomProbability: 1,
    minCooldownSeconds: 0,
    maxPreviewUrls: 5,
  };
  const settings = defaultGuildSettings(capabilities);
  settings.moderationVote = {
    threshold: 2,
    voteWindowSeconds: 120,
    durationMinutes: 3,
    voterRoleIds: ['voter-role'],
  };
  return settings;
};
describe('guild-configured moderation votes', () => {
  it('uses server parameters and only pings allowed voter roles', async () => {
    const { bot, interaction, send, timeout, reply } = build({
      votes: 100,
      timeoutSucceeds: true,
      settings: guildSettings(),
    });
    const translate = vi.fn((key: string) => key);
    bot.translator = { ...echoTranslator(), t: translate };
    await new BanUser().execute(interaction, bot);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { roles: ['voter-role'] } }),
    );
    expect(translate).toHaveBeenCalledWith(
      'replies:ban_user.vote_call_seconds',
      expect.objectContaining({ threshold: 2, judgeSeconds: 120, duration: 3 }),
    );
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.vote_failed'));
    expect(timeout).not.toHaveBeenCalled();
  });
  it('cancels outstanding votes when moderation is switched off', async () => {
    const { bot, interaction, timeout, reply } = build({
      votes: 100,
      timeoutSucceeds: true,
      settings: guildSettings(),
    });
    const enabled = vi.fn(() => true);
    Object.assign(bot.guildSettings!, { isEnabled: enabled });
    await new BanUser().execute(interaction, bot);
    enabled.mockReturnValue(false);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.vote_cancelled'));
    expect(timeout).not.toHaveBeenCalled();
  });
  it('cancels a poll when the saved voter-role policy changes', async () => {
    const settings = guildSettings();
    const { bot, interaction, timeout, reply } = build({
      votes: 100,
      timeoutSucceeds: true,
      settings,
    });
    await new BanUser().execute(interaction, bot);
    settings.moderationVote.voterRoleIds = ['replacement-role'];
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.vote_cancelled'));
    expect(timeout).not.toHaveBeenCalled();
  });
  it('does not start a poll against a protected or unmoderatable member', async () => {
    const { bot, interaction, send, sink } = build({
      votes: 100,
      timeoutSucceeds: true,
      settings: guildSettings(),
      moderatable: false,
    });
    await new BanUser().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:ban_user.target_ineligible' }]);
    expect(send).not.toHaveBeenCalled();
    expect(scheduledCallbacks).toHaveLength(0);
  });
  it('does not fall back to deletion when Discord refuses a configured timeout', async () => {
    const { bot, interaction, reply, judgeMessage, clientListeners } = build({
      votes: 100,
      timeoutSucceeds: false,
      settings: guildSettings(),
    });
    judgeMessage.reactions.resolve = () => ({
      count: 100,
      users: {
        fetch: vi.fn(
          async () =>
            new Collection([
              ['voter-a', { id: 'voter-a', bot: false }],
              ['voter-b', { id: 'voter-b', bot: false }],
            ]),
        ),
      },
    });
    await new BanUser().execute(interaction, bot);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.timeout_refused'));
    expect(clientListeners.size).toBe(0);
  });
  it('applies the configured default duration after enough eligible votes', async () => {
    const settings = guildSettings();
    settings.moderationVote.threshold = 2;
    const { bot, interaction, timeout, judgeMessage } = build({
      votes: 0,
      timeoutSucceeds: true,
      settings,
    });
    const reaction = {
      count: 0,
      users: {
        fetch: vi.fn(
          async () =>
            new Collection([
              ['voter-a', { id: 'voter-a', bot: false }],
              ['voter-b', { id: 'voter-b', bot: false }],
            ]),
        ),
      },
    };
    judgeMessage.reactions.resolve = () => reaction;
    await new BanUser().execute(interaction, bot);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() =>
      expect(timeout).toHaveBeenCalledWith(180000, 'replies:ban_user.timeout_reason'),
    );
  });
});
