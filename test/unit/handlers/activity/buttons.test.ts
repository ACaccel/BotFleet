/**
 * The activity post's buttons: join refusals name their reason, a role
 * limit is enforced, and only the organizer or a manager may close.
 */
import { describe, expect, it, vi } from 'vitest';

import ActivityButtons from '../../../../src/handlers/buttons/activity';
import { ok } from '../../../../src/core/result';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const stored = (overrides: Record<string, unknown> = {}) => ({
  activity_id: 'a1',
  message_id: 'a1',
  channel_id: 'c1',
  title: 'Games',
  creator_id: 'creator',
  expired_at: Date.now() + 60_000,
  status: 'open',
  participants: ['u1'],
  attendance: [],
  ...overrides,
});

const run = async (
  action: string,
  doc: ReturnType<typeof stored>,
  { roles = [] as string[], joins = false, manager = false, userId = 'member' } = {},
) => {
  const activity = {
    findByActivityId: vi.fn(async () => ok(doc)),
    join: vi.fn(async () => ok(joins)),
    leave: vi.fn(async () => ok(false)),
    finish: vi.fn(async () => ok(true)),
  };
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: `activity|${action}`,
    userId,
    guild: buildGuild({ id: 'g1' }),
    sink,
  });
  // The button builder has no `deferReply`, message, member or channel.
  Object.assign(interaction, {
    message: { id: 'a1' },
    channel: null,
    member: buildGuildMember({ id: userId, roleIds: roles }),
    memberPermissions: { has: () => manager },
    deferReply: async (opts?: { flags?: number }) => {
      sink.defers.push(opts ?? {});
      sink.acknowledged.deferred = true;
    },
  });
  const { bot } = buildFakeBot({
    getRepos: () => ({ activity }),
    isAdmin: () => false,
    client: { guilds: { cache: new Map() } },
    guildRegistry: { getRepos: () => ({ activity }) },
    jobMap: new Map(),
  });
  await new ActivityButtons().execute(interaction, bot);
  return { activity, sink, content: sink.editReplies[0]?.content };
};

describe('activity buttons', () => {
  it('refuses members without the required role before touching the list', async () => {
    const { activity, content } = await run('join', stored({ role_id: 'r1' }));
    expect(content).toBe('replies:activity.role_required');
    expect(activity.join).not.toHaveBeenCalled();
  });

  it('names why a join changed nothing', async () => {
    expect((await run('join', stored({ capacity: 1 }))).content).toBe('replies:activity.full');
    expect((await run('join', stored(), { userId: 'u1' })).content).toBe(
      'replies:activity.already_joined',
    );
    expect((await run('join', stored({ status: 'closed' }))).content).toBe(
      'replies:activity.not_open',
    );
  });

  it('lets only the organizer or a manager close sign-ups', async () => {
    const refused = await run('close', stored());
    expect(refused.content).toBe('replies:activity.manage_forbidden');
    expect(refused.activity.finish).not.toHaveBeenCalled();

    const organizer = await run('close', stored(), { userId: 'creator' });
    expect(organizer.activity.finish).toHaveBeenCalled();
    expect(organizer.content).toBe('replies:activity.closed');
  });
});
