/**
 * The activity post's buttons: join refusals name their reason, a role
 * limit is enforced, and only the organizer or a manager may close.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

import ActivityButtons from '../../../../src/handlers/buttons/activity';
import { ok } from '../../../../src/core/result';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

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
  const editReply = vi.fn(async (_options: unknown) => undefined);
  const interaction = {
    customId: `activity|${action}`,
    deferReply: vi.fn(async () => undefined),
    editReply,
    message: { id: 'a1' },
    guild: { id: 'g1', channels: { cache: new Map() } },
    guildId: 'g1',
    channel: null,
    user: { id: userId },
    member: { roles: { cache: new Map(roles.map((id) => [id, {}])) } },
    memberPermissions: { has: () => manager },
  } as unknown as ButtonInteraction;
  const { bot } = buildFakeBot({
    getRepos: () => ({ activity }),
    isAdmin: () => false,
    client: { guilds: { cache: new Map() } },
    guildRegistry: { getRepos: () => ({ activity }) },
    jobMap: new Map(),
  });
  await new ActivityButtons().execute(interaction, bot);
  return { activity, content: (editReply.mock.calls[0]?.[0] as { content: string }).content };
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
  });
});
