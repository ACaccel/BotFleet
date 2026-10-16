import type { Guild, GuildMember, Role } from 'discord.js';

import type { Logger } from '../../../core/logger';
import type { Mee6Player } from '../mee6-shared/leaderboard';

/** A level threshold and the role granted from that level up. */
export interface LevelRole {
  readonly level: number;
  readonly role: Role;
}

export interface SyncSummary {
  readonly granted: number;
  readonly removed: number;
  readonly failed: number;
}

/** Members changed at once; role edits share one route's rate limit. */
const CONCURRENCY = 4;
/** Discord resolves at most 100 members per fetch. */
const MEMBER_BATCH = 100;

/**
 * Resolve `level_<n>` role IDs to roles the bot can manage, lowest level
 * first.
 */
export const resolveLevelRoles = (
  guild: Guild,
  levelRoles: Readonly<Record<string, string>>,
  logger: Pick<Logger, 'warn'> | undefined,
): LevelRole[] => {
  const highest = guild.members.me?.roles.highest;
  const resolved: LevelRole[] = [];
  for (const [key, value] of Object.entries(levelRoles)) {
    const role = guild.roles.cache.get(value);
    if (role === undefined || highest === undefined || role.comparePositionTo(highest) >= 0) {
      logger?.warn({ guildId: guild.id, key, value }, 'level role missing or above the bot');
      continue;
    }
    resolved.push({ level: Number(key.slice('level_'.length)), role });
  }
  return resolved.sort((a, b) => a.level - b.level);
};

/** The role for `level`: the highest threshold the member has reached, if any. */
export const targetRoleFor = (level: number, levelRoles: readonly LevelRole[]): Role | undefined =>
  levelRoles.filter((entry) => level >= entry.level).at(-1)?.role;

const fetchMembers = async (
  guild: Guild,
  ids: readonly string[],
  logger: Pick<Logger, 'warn'> | undefined,
): Promise<ReadonlySet<string>> => {
  const missing = [...new Set(ids)].filter((id) => !guild.members.cache.has(id));
  const failed = new Set<string>();
  for (let i = 0; i < missing.length; i += MEMBER_BATCH) {
    const batch = missing.slice(i, i + MEMBER_BATCH);
    try {
      await guild.members.fetch({ user: batch });
    } catch (error) {
      const unresolved = batch.filter((id) => !guild.members.cache.has(id));
      unresolved.forEach((id) => failed.add(id));
      logger?.warn(
        { err: error, guildId: guild.id, memberIds: unresolved },
        'level role member fetch failed',
      );
    }
    // A successful bulk fetch omits members who have left the guild.
  }
  return failed;
};

/** Give each member exactly the role for their level, counting changes and failures. */
export const syncLevelRoles = async (
  guild: Guild,
  players: readonly Mee6Player[],
  levelRoles: readonly LevelRole[],
  logger: Pick<Logger, 'warn'> | undefined,
): Promise<SyncSummary> => {
  const fetchFailures = await fetchMembers(
    guild,
    players.map((player) => player.id),
    logger,
  );
  const managed = new Set(levelRoles.map((entry) => entry.role.id));
  let granted = 0;
  let removed = 0;
  let failed = fetchFailures.size;

  const syncOne = async (member: GuildMember, level: number): Promise<void> => {
    const target = targetRoleFor(level, levelRoles);
    const stale = [...member.roles.cache.keys()].filter(
      (id) => managed.has(id) && id !== target?.id,
    );
    try {
      if (target !== undefined && !member.roles.cache.has(target.id)) {
        await member.roles.add(target);
        granted += 1;
      }
      if (stale.length > 0) {
        await member.roles.remove(stale);
        removed += stale.length;
      }
    } catch (error) {
      failed += 1;
      logger?.warn(
        { err: error, guildId: guild.id, memberId: member.id },
        'level role sync failed',
      );
    }
  };

  const queue = players.flatMap((player) => {
    const member = guild.members.cache.get(player.id);
    return member === undefined ? [] : [{ member, level: player.level }];
  });
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await syncOne(next.member, next.level);
    }
  });
  await Promise.all(workers);
  return { granted, removed, failed };
};
