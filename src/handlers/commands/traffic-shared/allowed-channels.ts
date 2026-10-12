/**
 * Adapts a discord.js guild and the invoking member to the pure visibility rules
 * of `visibility-filter.ts`: View Channel and Manage Threads per cached channel,
 * the rank policy, and for a `public` reply the roles that can view the command
 * channel. {@link loadVisibleScope} also reads the archive's channel records and
 * whether a full backup has completed.
 */
import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionsBitField,
  type Role,
} from 'discord.js';
import type { PermissionRankPolicy } from '@core/plugin';

import type { ArchiveChannelInfo } from '../../../core/archive/stats';
import type { DatabaseError } from '../../../core/errors/external-service-error';
import { parentChannelIdOf } from '../../../infra/discord';
import type { Repos } from '../../../persistence/repositories';

import type { Visibility } from './types';
import { resolveVisibleChannelIds, type LiveChannelAccess } from './visibility-filter';

type PermissionTarget = {
  permissionsFor(subject: GuildMember | Role): Readonly<PermissionsBitField> | null;
};
const canViewAs = (channel: PermissionTarget, subject: GuildMember | Role): boolean =>
  channel.permissionsFor(subject)?.has(PermissionFlagsBits.ViewChannel) ?? false;

/**
 * The roles that can view the command channel, or `undefined` when the channel is
 * not cached and its audience is unknown.
 */
const commandAudience = (guild: Guild, commandChannelId: string): Role[] | undefined => {
  const channel = guild.channels.cache.get(commandChannelId);
  if (channel === undefined || !('permissionsFor' in channel)) return undefined;
  return [...guild.roles.cache.values()].filter((role) => canViewAs(channel, role));
};

/** The invoking member's access to every cached channel of the guild. */
const liveChannelAccessOf = (
  guild: Guild,
  member: GuildMember,
  audience: readonly Role[] | undefined,
): ReadonlyMap<string, LiveChannelAccess> => {
  const access = new Map<string, LiveChannelAccess>();
  for (const [channelId, channel] of guild.channels.cache) {
    const permissions = 'permissionsFor' in channel ? channel.permissionsFor(member) : null;
    access.set(channelId, {
      type: channel.type,
      parentId: parentChannelIdOf(channel),
      canView: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
      canManageThreads: permissions?.has(PermissionFlagsBits.ManageThreads) ?? false,
      audienceCanView:
        audience !== undefined &&
        'permissionsFor' in channel &&
        audience.every((role) => canViewAs(channel, role)),
    });
  }
  return access;
};

interface VisibilityFilterInput {
  readonly guild: Guild;
  /** The invoker; `/traffic user` still filters by the invoker, not the counted member. */
  readonly member: GuildMember;
  readonly policy: PermissionRankPolicy;
  readonly mode: Visibility;
  readonly commandChannelId: string;
  /** `ArchiveStatsRepo.listChannels()`. */
  readonly records: readonly ArchiveChannelInfo[];
}

export const buildAllowedChannelSet = (input: VisibilityFilterInput): ReadonlySet<string> => {
  const { guild, member, policy } = input;
  // Role coverage is only needed for a public reply; it costs a check per role and channel.
  const audience = input.mode === 'public' ? commandAudience(guild, input.commandChannelId) : [];
  return resolveVisibleChannelIds({
    records: input.records,
    live: liveChannelAccessOf(guild, member, audience),
    mode: input.mode,
    userRank: policy.userRank(guild.id, member.roles.cache.keys()),
    commandChannelId: input.commandChannelId,
    channelRank: (channelId, ancestorIds) => policy.channelRank(guild.id, channelId, ancestorIds),
  });
};

/** The archive's channel records and the invoker's visible channels among them. */
export const loadVisibleScope = async (
  repos: Repos,
  input: Omit<Parameters<typeof buildAllowedChannelSet>[0], 'records'>,
): Promise<
  | {
      readonly ok: true;
      readonly records: readonly ArchiveChannelInfo[];
      readonly visible: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly error: DatabaseError }
> => {
  const records = await repos.archiveStats.listChannels();
  if (!records.ok) return records;
  return {
    ok: true,
    records: records.value,
    visible: buildAllowedChannelSet({ ...input, records: records.value }),
  };
};
