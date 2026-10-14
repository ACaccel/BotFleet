/**
 * Minimal Guild builder for unit / integration tests. Returns the
 * structural subset that handler / plugin code touches — id, name,
 * `channels.cache`, `members.cache`, `roles`, `emojis.cache`,
 * `stickers.cache`. Tests that need more can
 * spread extra fields into the return.
 */
import { vi, type Mock } from 'vitest';
import type { Guild, GuildBasedChannel } from 'discord.js';

/**
 * A role spec. `position`, `permissions` and `managed` feed the
 * hierarchy and dangerous-permission checks on self-service roles.
 */
interface RoleSpec {
  readonly id: string;
  readonly name: string;
  readonly position?: number;
  /** Permission flags the role grants; `has` answers from this list. */
  readonly permissions?: readonly bigint[];
  readonly managed?: boolean;
}

interface RoleFake {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly managed: boolean;
  readonly permissions: { has: (flag: bigint) => boolean };
  readonly comparePositionTo: (other: { readonly position: number }) => number;
  /** Back-reference filled in by `buildGuild`, as discord.js exposes `role.guild`. */
  guild?: Guild;
}

const buildRole = (spec: RoleSpec): RoleFake => {
  const position = spec.position ?? 1;
  return {
    id: spec.id,
    name: spec.name,
    position,
    managed: spec.managed ?? false,
    permissions: { has: (flag) => (spec.permissions ?? []).includes(flag) },
    comparePositionTo: (other) => position - other.position,
  };
};

/**
 * Role manager stand-in. `create` / `delete` stay `vi.fn()` mocks
 * rather than call-recording arrays so a test can drive the failure
 * branches with `mockRejectedValue`.
 */
interface GuildRolesFake {
  /** Backs both `roles.cache.size` (role-ceiling checks) and `.get(id)`. */
  readonly cache: Map<string, RoleFake>;
  readonly create: Mock;
  readonly delete: Mock;
  readonly everyone: { readonly id: string };
}

interface BuildGuildRolesInput {
  /** How many roles the guild already has; drives `roles.cache.size`. */
  readonly roleCount?: number;
  /** Roles resolvable by id through `roles.cache.get`. */
  readonly roles?: readonly RoleSpec[];
  /** Id of the role `roles.create` resolves with. */
  readonly createdRoleId?: string;
  readonly everyoneRoleId?: string;
}

export const buildGuildRoles = (input: BuildGuildRolesInput = {}): GuildRolesFake => {
  const cache = new Map<string, RoleFake>();
  for (let i = 0; i < (input.roleCount ?? 0); i += 1) {
    const id = `filler-${String(i)}`;
    cache.set(id, buildRole({ id, name: id }));
  }
  for (const role of input.roles ?? []) {
    cache.set(role.id, buildRole(role));
  }
  return {
    cache,
    create: vi.fn().mockResolvedValue({ id: input.createdRoleId ?? 'role-1' }),
    delete: vi.fn().mockResolvedValue(undefined),
    everyone: { id: input.everyoneRoleId ?? 'everyone' },
  };
};

interface BuildGuildInput {
  readonly id?: string;
  readonly name?: string;
  /**
   * Pre-populated channel cache. Typed as the real channel union rather
   * than `{ id }`, because callers read `isTextBased()` / `isSendable()`
   * / `permissionsFor()` off whatever the cache returns — a looser type
   * here would let a fixture compile and then fail at runtime.
   * Build entries with `buildTextChannel`.
   */
  readonly channels?: readonly GuildBasedChannel[];
  /** Pre-populated member cache. Tests pass members built by `buildGuildMember`. */
  readonly members?: readonly { id: string; displayName?: string }[];
  /** Pre-populated custom emoji cache, for handlers that count or list them. */
  readonly emojis?: readonly { readonly id: string }[];
  /** Pre-populated sticker cache, for handlers that count or list them. */
  readonly stickers?: readonly { readonly id: string }[];
  /**
   * The bot's own member (`guild.members.me`), which permission checks
   * on a target channel resolve against. `null` by default, the state a
   * handler must survive rather than assume away.
   */
  readonly me?: { readonly id: string } | null;
  /** Guild owner id; `role` checks exempt the owner from hierarchy limits. */
  readonly ownerId?: string;
  /** Role manager from {@link buildGuildRoles}; defaults to an empty one. */
  readonly roles?: GuildRolesFake;
  /** Id of the synthetic `@everyone` role. Ignored when `roles` is given. */
  readonly everyoneRoleId?: string;
}

export const buildGuild = (input: BuildGuildInput = {}): Guild => {
  const channelCache = new Map<string, unknown>();
  for (const ch of input.channels ?? []) {
    channelCache.set(ch.id, ch);
  }
  const memberCache = new Map<string, unknown>();
  for (const m of input.members ?? []) {
    memberCache.set(m.id, m);
  }
  const emojiCache = new Map((input.emojis ?? []).map((emoji) => [emoji.id, emoji]));
  const stickerCache = new Map((input.stickers ?? []).map((sticker) => [sticker.id, sticker]));
  const roles = input.roles ?? buildGuildRoles({ everyoneRoleId: input.everyoneRoleId });
  const guild = {
    id: input.id ?? 'g-1',
    name: input.name ?? 'TestGuild',
    ownerId: input.ownerId ?? 'owner',
    channels: { cache: channelCache },
    members: { cache: memberCache, me: input.me ?? null },
    roles,
    emojis: { cache: emojiCache },
    stickers: { cache: stickerCache },
  } as unknown as Guild;
  for (const role of roles.cache.values()) role.guild = guild;
  return guild;
};
