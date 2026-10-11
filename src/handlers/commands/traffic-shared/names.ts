/**
 * Display names for `/traffic` rows. The live guild name wins; a member who
 * left falls back to the newest name stored with their messages
 * (`globalName ?? username`), and a deleted channel to the last name
 * `archive_channels` recorded, so past activity stays recognisable.
 */
import type { Guild } from 'discord.js';

import type { ArchiveChannelInfo } from '../../../core/archive/stats';

interface StoredUserNames {
  readonly username?: string;
  readonly globalName?: string;
}

export const memberName = (
  guild: Guild,
  userId: string,
  stored: StoredUserNames,
  fallback: string,
): string =>
  guild.members.cache.get(userId)?.displayName ?? stored.globalName ?? stored.username ?? fallback;

/** The whole batch of user lookups gives up after this, leaving the fallback name. */
const LOOKUP_DEADLINE_MS = 5_000;

/**
 * Names of members known only by ID (conversation partners, app users): the
 * member cache first, then one uncached user lookup per remaining ID, all within
 * one deadline. A lookup that fails or is late leaves `fallback`, so a deleted
 * account or a slow API never fails the reply.
 */
export const resolveUserNames = async (
  guild: Guild,
  userIds: readonly string[],
  fallback: string,
): Promise<ReadonlyMap<string, string>> => {
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const userId of new Set(userIds)) {
    const cached = guild.members.cache.get(userId)?.displayName;
    if (cached === undefined) missing.push(userId);
    else names.set(userId, cached);
  }
  for (const userId of missing) names.set(userId, fallback);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LOOKUP_DEADLINE_MS);
  });
  const lookups = missing.map(async (userId) => {
    const user = await guild.client.users.fetch(userId, { cache: false });
    names.set(userId, user.globalName ?? user.username);
  });
  try {
    await Promise.race([Promise.allSettled(lookups), deadline]);
  } finally {
    clearTimeout(timer);
  }
  return new Map(names);
};

export type ChannelRecords = ReadonlyMap<string, ArchiveChannelInfo>;

export const channelRecordsOf = (records: readonly ArchiveChannelInfo[]): ChannelRecords =>
  new Map(records.map((record) => [record.channelId, record]));

export const channelName = (
  guild: Guild,
  records: ChannelRecords,
  channelId: string,
  stored?: string,
): string | undefined =>
  guild.channels.cache.get(channelId)?.name ?? stored ?? records.get(channelId)?.name;

/** IDs of the bots the client knows of; conversation partners are known only by ID. */
export const cachedBotIds = (guild: Guild): string[] => {
  const ids = new Set<string>();
  for (const [userId, member] of guild.members.cache) if (member.user.bot) ids.add(userId);
  for (const [userId, user] of guild.client.users.cache) if (user.bot) ids.add(userId);
  return [...ids];
};
