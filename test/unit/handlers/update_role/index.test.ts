/**
 * `/role sync` gives each ranked member exactly the role for their level,
 * reports one summary instead of a message per change, and runs at most
 * once per guild every ten minutes.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type GuildMember, type Role } from 'discord.js';

const { fetchMee6Leaderboard } = vi.hoisted(() => ({ fetchMee6Leaderboard: vi.fn() }));
vi.mock('../../../../src/handlers/commands/mee6-shared/leaderboard', () => ({
  fetchMee6Leaderboard: (...args: unknown[]) => fetchMee6Leaderboard(...args),
}));

import LevelRoleSync from '../../../../src/handlers/commands/update_role/action';
import {
  resolveLevelRoles,
  syncLevelRoles,
  targetRoleFor,
} from '../../../../src/handlers/commands/update_role/sync';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildGuildMember, buildMemberRoles } from '../../../fixtures/discord/member-builder';

const roleManager = buildGuildRoles({
  roles: [
    { id: '100000000000000001', name: 'Rookie', position: 1 },
    { id: '100000000000000002', name: 'Veteran', position: 1 },
  ],
});
// The roles every guild below shares, read back as the discord.js type.
const catalog = buildGuild({ roles: roleManager });
const roleById = (id: string): Role => catalog.roles.cache.get(id)!;

const ROOKIE = roleById('100000000000000001');
const VETERAN = roleById('100000000000000002');

const memberWith = (id: string, roleIds: string[]) => {
  const { add, remove } = buildMemberRoles();
  const member = buildGuildMember({ id, roleIds, roles: { add, remove } });
  // Grants and removals write through to the cache the handler reads back.
  const cache = member.roles.cache;
  add.mockImplementation(async (r: Role) => void cache.set(r.id, r));
  remove.mockImplementation(async (ids: string[]) => ids.forEach((roleId) => cache.delete(roleId)));
  return { member, add, remove };
};

const guildWith = (members: GuildMember[], id = 'g1') => {
  const fetch = vi.fn(async () => undefined);
  const guild = buildGuild({
    id,
    roles: roleManager,
    members,
    me: buildGuildMember({ id: 'bot', highestRolePosition: 10 }),
  });
  Object.assign(guild.members, { fetch });
  return { guild, fetch };
};

const player = (id: string, level: number) => ({ id, level }) as never;

afterEach(() => vi.clearAllMocks());

describe('level role sync', () => {
  const levels = [
    { level: 5, role: ROOKIE },
    { level: 20, role: VETERAN },
  ];

  it('picks the highest threshold reached', () => {
    expect(targetRoleFor(4, levels)).toBeUndefined();
    expect(targetRoleFor(5, levels)).toBe(ROOKIE);
    expect(targetRoleFor(25, levels)).toBe(VETERAN);
  });

  it('resolves role IDs lowest level first, skipping missing roles', () => {
    const { guild } = guildWith([]);
    const warn = vi.fn();
    const resolved = resolveLevelRoles(
      guild,
      { level_20: VETERAN.id, level_5: ROOKIE.id, level_9: '100000000000000009' },
      { warn },
    );
    expect(resolved.map((entry) => entry.role)).toEqual([ROOKIE, VETERAN]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('swaps a promoted member to their new role and counts the changes', async () => {
    const promoted = memberWith('u1', [ROOKIE.id]);
    const unranked = memberWith('u2', []);
    const { guild } = guildWith([promoted.member, unranked.member]);

    const summary = await syncLevelRoles(
      guild,
      [player('u1', 21), player('u2', 1)],
      levels,
      undefined,
    );

    expect(summary).toEqual({ granted: 1, removed: 1, failed: 0 });
    expect([...promoted.member.roles.cache.keys()]).toEqual([VETERAN.id]);
  });

  it('keeps the previous role when granting its replacement fails', async () => {
    const member = memberWith('u1', [ROOKIE.id]);
    member.add.mockRejectedValueOnce(new Error('Missing Permissions'));

    const summary = await syncLevelRoles(
      guildWith([member.member]).guild,
      [player('u1', 21)],
      levels,
      undefined,
    );

    expect(summary).toEqual({ granted: 0, removed: 0, failed: 1 });
    expect(member.member.roles.cache.has(ROOKIE.id)).toBe(true);
    expect(member.remove).not.toHaveBeenCalled();
  });

  it('counts members unresolved after a failed fetch and still syncs cached members', async () => {
    const member = memberWith('cached', []);
    const { guild, fetch } = guildWith([member.member]);
    const error = new Error('Gateway timeout');
    fetch.mockRejectedValueOnce(error);
    const logger = { warn: vi.fn() };

    const summary = await syncLevelRoles(
      guild,
      [player('cached', 5), player('missing-1', 5), player('missing-2', 20)],
      levels,
      logger,
    );

    expect(summary).toEqual({ granted: 1, removed: 0, failed: 2 });
    expect(logger.warn).toHaveBeenCalledWith(
      { err: error, guildId: 'g1', memberIds: ['missing-1', 'missing-2'] },
      'level role member fetch failed',
    );
  });

  it('does not count departed members omitted by a successful fetch as failures', async () => {
    const logger = { warn: vi.fn() };

    const summary = await syncLevelRoles(
      guildWith([]).guild,
      [player('departed', 20)],
      levels,
      logger,
    );

    expect(summary).toEqual({ granted: 0, removed: 0, failed: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('syncs members populated before a partial fetch failure', async () => {
    const member = memberWith('fetched', []);
    const { guild, fetch } = guildWith([]);
    fetch.mockImplementationOnce(async () => {
      guild.members.cache.set(member.member.id, member.member);
      throw new Error('Gateway timeout');
    });

    const summary = await syncLevelRoles(
      guild,
      [player('fetched', 5), player('missing', 5)],
      levels,
      undefined,
    );

    expect(summary).toEqual({ granted: 1, removed: 0, failed: 1 });
  });

  it('counts a failed member and carries on', async () => {
    const broken = memberWith('u1', []);
    broken.add.mockRejectedValueOnce(new Error('Missing Permissions'));
    const fine = memberWith('u2', []);

    const summary = await syncLevelRoles(
      guildWith([broken.member, fine.member]).guild,
      [player('u1', 5), player('u2', 5)],
      levels,
      { warn: vi.fn() },
    );

    expect(summary).toEqual({ granted: 1, removed: 0, failed: 1 });
    expect(fine.member.roles.cache.has(ROOKIE.id)).toBe(true);
  });
});

describe('/role sync', () => {
  const run = async (
    guildId: string,
    config: unknown = { level_roles: { level_5: ROOKIE.id } },
  ) => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({
      guild: guildWith([], guildId).guild,
      sink,
    });
    const { bot } = buildFakeBot({ config });
    await new LevelRoleSync().execute(interaction, bot);
    return sink;
  };

  it('answers with one summary, then refuses a second run within ten minutes', async () => {
    fetchMee6Leaderboard.mockResolvedValue([]);

    const first = await run('g-cooldown');
    expect(first.defers).toEqual([{}]);
    expect(first.editReplies).toEqual([{ content: 'replies:update_role.summary' }]);

    const second = await run('g-cooldown');
    expect(second.defers).toEqual([]);
    expect(second.replies).toEqual([
      { content: 'replies:update_role.cooldown', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('explains an unreadable leaderboard and allows an immediate retry', async () => {
    fetchMee6Leaderboard.mockRejectedValueOnce(new Error('403'));
    const failed = await run('g-unavailable');
    expect(failed.editReplies).toEqual([{ content: 'replies:update_role.unavailable' }]);

    fetchMee6Leaderboard.mockResolvedValueOnce([]);
    const retried = await run('g-unavailable');
    expect(retried.editReplies).toEqual([{ content: 'replies:update_role.summary' }]);
  });

  it('answers no_config when level roles are not configured', async () => {
    const sink = await run('g-none', {});
    expect(sink.replies).toEqual([
      { content: 'replies:update_role.no_config', flags: MessageFlags.Ephemeral },
    ]);
    expect(sink.defers).toEqual([]);
  });
});
