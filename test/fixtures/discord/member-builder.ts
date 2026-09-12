/**
 * Minimal GuildMember builder. Tests need this shape to feed
 * `interaction.member` and `guild.members.cache.get`.
 */
import { vi, type Mock } from 'vitest';
import type { GuildMember } from 'discord.js';

/** Spies on the member's role grants, for handlers that toggle a role. */
interface MemberRolesFake {
  readonly add: Mock;
  readonly remove: Mock;
}

interface BuildGuildMemberInput {
  readonly id?: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly roleIds?: readonly string[];
  /** Spies the built member's `roles.add` / `roles.remove` write into. */
  readonly roles?: MemberRolesFake;
}

export const buildMemberRoles = (): MemberRolesFake => ({
  add: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
});

export const buildGuildMember = (input: BuildGuildMemberInput = {}): GuildMember => {
  const id = input.id ?? 'u-1';
  const roleCache = new Map<string, unknown>();
  for (const rid of input.roleIds ?? []) {
    roleCache.set(rid, { id: rid });
  }
  return {
    id,
    displayName: input.displayName ?? input.username ?? 'tester',
    user: {
      id,
      username: input.username ?? 'tester',
      displayName: input.displayName ?? input.username ?? 'tester',
      bot: false,
      displayAvatarURL: () => `https://cdn.example/${id}.png`,
    },
    roles: { cache: roleCache, ...(input.roles ?? buildMemberRoles()) },
  } as unknown as GuildMember;
};
