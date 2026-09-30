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
import type { ChatInputCommandInteraction } from 'discord.js';

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
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const GUILD_ID = 'g1';
const TARGET_ID = 'u-target';

interface Fixture {
  /** Reaction count reported on the judgement message (excludes the bot's own). */
  readonly votes: number;
  /** Whether `member.timeout` resolves. */
  readonly timeoutSucceeds: boolean;
}

const build = (fixture: Fixture) => {
  const reply = vi.fn(async () => undefined);
  const judgeMessage = {
    reactions: { resolve: () => ({ count: fixture.votes + 1 }) },
    reply,
    react: vi.fn(async () => undefined),
    id: 'judge-1',
    guildId: GUILD_ID,
  };
  const member = {
    id: TARGET_ID,
    displayName: 'Target',
    user: { bot: false, tag: 'target#1', displayName: 'Target' },
    timeout: vi.fn(async () => {
      if (!fixture.timeoutSucceeds) throw new Error('Missing Permissions');
    }),
  };
  const clientListeners = new Map<string, unknown>();
  const { bot, logger } = buildFakeBot({
    client: {
      prependListener: (event: string, fn: unknown) => clientListeners.set(event, fn),
      off: (event: string) => clientListeners.delete(event),
    },
    getGuildInfo: () => ({ roles: { ban_user: { id: 'role-1' } } }),
  });

  const interaction = {
    deferReply: vi.fn(async () => undefined),
    deleteReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    deferred: true,
    replied: false,
    guild: { id: GUILD_ID, members: { cache: new Map([[TARGET_ID, member]]) } },
    member: { displayName: 'Initiator' },
    user: { id: 'u-init', username: 'initiator' },
    channel: { isSendable: () => true, send: vi.fn(async () => judgeMessage) },
    options: {
      get: (name: string) => (name === 'user' ? { value: TARGET_ID } : undefined),
    },
  } as unknown as ChatInputCommandInteraction;

  return { bot, interaction, member, reply, error: logger.error, clientListeners };
};

afterEach(() => {
  scheduledCallbacks.length = 0;
  vi.clearAllMocks();
});

describe('ban_user judgement', () => {
  it('times the target out when the vote threshold is met', async () => {
    const { bot, interaction, member, reply } = build({ votes: 5, timeoutSucceeds: true });

    await new BanUser().execute(interaction, bot);
    expect(scheduledCallbacks).toHaveLength(1);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(member.timeout).toHaveBeenCalledTimes(1));

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
    const { bot, interaction, member, reply } = build({ votes: 1, timeoutSucceeds: true });

    await new BanUser().execute(interaction, bot);
    scheduledCallbacks[0]?.();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('replies:ban_user.vote_failed'));

    expect(member.timeout).not.toHaveBeenCalled();
  });

  it('routes a rejected judgement to the logger rather than an unhandled rejection', async () => {
    const { bot, interaction, error } = build({ votes: 5, timeoutSucceeds: true });
    await new BanUser().execute(interaction, bot);

    // node-schedule discards the value its callback returns, so without
    // the wrapper the rejection had no path back to this vote.
    (bot.translator as unknown as { t: () => string }).t = () => {
      throw new Error('catalog exploded');
    };
    expect(() => scheduledCallbacks[0]?.()).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});
