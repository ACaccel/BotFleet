import { PermissionFlagsBits, type GuildMember, type Role } from 'discord.js';

/**
 * Permissions a self-service role button must never hand out: any of
 * them lets a clicking member moderate others or escalate further.
 */
const DANGEROUS_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

/**
 * Whether any member may toggle `role` on themselves through the bot:
 * it must be an ordinary role the bot can manage and must carry no
 * moderation or administrative permission.
 */
export const isSelfAssignableRole = (role: Role, botMember: GuildMember | null): boolean => {
  if (role.managed || role.id === role.guild.id) return false;
  if (botMember === null || role.comparePositionTo(botMember.roles.highest) >= 0) return false;
  return !DANGEROUS_PERMISSIONS.some((flag) => role.permissions.has(flag, false));
};

/**
 * Whether `member` may publish `role` for self-service: only roles below
 * their own highest role, so a panel cannot grant more than its author holds.
 */
export const canOfferRole = (role: Role, member: GuildMember): boolean =>
  member.id === role.guild.ownerId || role.comparePositionTo(member.roles.highest) < 0;
