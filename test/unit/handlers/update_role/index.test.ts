/**
 * `/role sync` gives each ranked member exactly the role for their level,
 * reports one summary instead of a message per change, and runs at most
 * once per guild every ten minutes.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, Guild, Role } from 'discord.js';

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

const role = (id: string, name: string, position = 1) =>
  ({
    id,
    name,
    comparePositionTo: (other: { position: number }) => position - other.position,
  }) as unknown as Role;

const ROOKIE = role('100000000000000001', 'Rookie');
const VETERAN = role('100000000000000002', 'Veteran');

const memberWith = (id: string, roleIds: string[]) => {
  const cache = new Map(roleIds.map((roleId) => [roleId, { id: roleId }]));
  return {
    id,
    roles: {
      cache,
      add: vi.fn(async (r: Role) => void cache.set(r.id, { id: r.id })),
      remove: vi.fn(async (ids: string[]) => ids.forEach((roleId) => cache.delete(roleId))),
    },
  };
};

const guildWith = (members: ReturnType<typeof memberWith>[]) =>
  ({
    id: 'g1',
    roles: {
      cache: new Map([
        [ROOKIE.id, ROOKIE],
        [VETERAN.id, VETERAN],
      ]),
    },
    members: {
      me: { roles: { highest: { position: 10 } } },
      cache: new Map(members.map((member) => [member.id, member])),
      fetch: vi.fn(async () => undefined),
    },
  }) as unknown as Guild;

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
    const guild = guildWith([]);
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
    const guild = guildWith([promoted, unranked]);

    const summary = await syncLevelRoles(
      guild,
      [player('u1', 21), player('u2', 1)],
      levels,
      undefined,
    );

    expect(summary).toEqual({ granted: 1, removed: 1, failed: 0 });
    expect([...promoted.roles.cache.keys()]).toEqual([VETERAN.id]);
  });

  it('keeps the previous role when granting its replacement fails', async () => {
    const member = memberWith('u1', [ROOKIE.id]);
    member.roles.add.mockRejectedValueOnce(new Error('Missing Permissions'));

    const summary = await syncLevelRoles(
      guildWith([member]),
      [player('u1', 21)],
      levels,
      undefined,
    );

    expect(summary).toEqual({ granted: 0, removed: 0, failed: 1 });
    expect(member.roles.cache.has(ROOKIE.id)).toBe(true);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('counts members unresolved after a failed fetch and still syncs cached members', async () => {
    const member = memberWith('cached', []);
    const guild = guildWith([member]);
    const error = new Error('Gateway timeout');
    vi.mocked(guild.members.fetch).mockRejectedValueOnce(error);
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

    const summary = await syncLevelRoles(guildWith([]), [player('departed', 20)], levels, logger);

    expect(summary).toEqual({ granted: 0, removed: 0, failed: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('syncs members populated before a partial fetch failure', async () => {
    const member = memberWith('fetched', []);
    const guild = guildWith([]);
    vi.mocked(guild.members.fetch).mockImplementationOnce(async () => {
      guild.members.cache.set(member.id, member as never);
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
    broken.roles.add.mockRejectedValueOnce(new Error('Missing Permissions'));
    const fine = memberWith('u2', []);

    const summary = await syncLevelRoles(
      guildWith([broken, fine]),
      [player('u1', 5), player('u2', 5)],
      levels,
      { warn: vi.fn() },
    );

    expect(summary).toEqual({ granted: 1, removed: 0, failed: 1 });
  });
});

describe('/role sync', () => {
  const run = async (
    guildId: string,
    config: unknown = { level_roles: { level_5: ROOKIE.id } },
  ) => {
    const reply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      reply,
      editReply,
      deferReply: vi.fn(async () => undefined),
      deferred: true,
      replied: false,
      guild: { ...guildWith([]), id: guildId },
      guildId,
    } as unknown as ChatInputCommandInteraction;
    const { bot } = buildFakeBot({ config });
    await new LevelRoleSync().execute(interaction, bot);
    return { reply, editReply };
  };

  it('answers with one summary, then refuses a second run within ten minutes', async () => {
    fetchMee6Leaderboard.mockResolvedValue([]);

    const first = await run('g-cooldown');
    expect(first.editReply).toHaveBeenCalledWith({ content: 'replies:update_role.summary' });

    const second = await run('g-cooldown');
    expect(second.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:update_role.cooldown' }),
    );
  });

  it('explains an unreadable leaderboard and allows an immediate retry', async () => {
    fetchMee6Leaderboard.mockRejectedValueOnce(new Error('403'));
    const failed = await run('g-unavailable');
    expect(failed.editReply).toHaveBeenCalledWith({ content: 'replies:update_role.unavailable' });

    fetchMee6Leaderboard.mockResolvedValueOnce([]);
    const retried = await run('g-unavailable');
    expect(retried.editReply).toHaveBeenCalledWith({ content: 'replies:update_role.summary' });
  });

  it('answers no_config when level roles are not configured', async () => {
    const { reply } = await run('g-none', {});
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:update_role.no_config' }),
    );
  });
});
