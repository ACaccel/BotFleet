/**
 * Temporary notification-role service.
 *
 * Shared by the temp-role plugin (expiry reboot) and the `/role temp`
 * handlers, which may not import each other. Mirrors the giveaway
 * service's shape: the surface takes a typed {@link TempRoleDeps} bundle
 * rather than the whole `BaseBot`, so the plugin can resolve its
 * dependencies through the IoC container (`ctx.resolve(...)`). The
 * handler bridges a `BaseBot` reference into this surface via
 * `buildTempRoleDepsFromBot`.
 *
 * A temp role is a permission-less, mentionable Discord role created on
 * demand and auto-deleted at `expires_at`. State lives in MongoDB; the
 * one-shot expiry jobs are ephemeral and rebuilt on every boot
 * (`rebootTempRoleJobs`), exactly like the giveaway scheduler.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError } from 'discord.js';
import type { Channel, Client, Guild, Message, Role } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildLookup } from '../guild-lookup';
import { bindTranslator, withGuildContext, type Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import { JobManager, retryWithBackoff } from '@core/scheduling';
import type { Clock } from '../../core/time';
import type { TempRoleDoc } from '../../persistence/schemas/temp-role.schema';

export interface TempRoleDeps {
  readonly client: Client;
  readonly registry: GuildLookup<'tempRole'>;
  readonly jobMap: Map<string, Job>;
  readonly logger: Logger;
  readonly translator: Translator | undefined;
  readonly clock: Clock;
}

/** Hard cap on the selectable lifetime (days). */
export const MAX_TEMP_ROLE_DAYS = 30;
/** Default lifetime applied when the `days` option is omitted. */
export const DEFAULT_TEMP_ROLE_DAYS = 30;
/**
 * Conservative guard against Discord's per-guild role ceiling (250,
 * counting `@everyone`). Blocking one slot early is preferable to a
 * failed `roles.create` API round-trip.
 */
export const MAX_GUILD_ROLES = 250;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Discord REST error code for "Maximum number of guild roles reached".
// The `roles.cache.size` guard catches the common case, but the cache can
// lag (or two creates can race), so the hard-ceiling rejection is mapped
// back to the same localised `role_limit` outcome.
const DISCORD_MAX_ROLES_ERROR = 30005;

// Audit-log reasons recorded against the Discord role lifecycle. Not
// user-facing bot copy, so they stay as plain English constants.
const AUDIT_REASON_CREATE = 'Temporary notification role created via /role temp create';
const AUDIT_REASON_EXPIRE = 'Temporary notification role expired';

export const tempRoleJobKey = (roleId: string): string => `temp-role:${roleId}`;

/** Discord renders `<t:unix:f>` in each viewer's own locale and timezone. */
const discordTimestamp = (epochMs: number): string => `<t:${Math.floor(epochMs / 1000)}:f>`;

/** Outcome of {@link createTempRole}; the handler maps it to i18n copy. */
type CreateTempRoleOutcome =
  | { readonly status: 'created'; readonly roleId: string; readonly expiresAt: number }
  | { readonly status: 'role_limit' }
  | { readonly status: 'no_db' }
  | { readonly status: 'announce_failed' }
  | { readonly status: 'too_many'; readonly max: number }
  | { readonly status: 'name_taken' };

interface CreateTempRoleArgs {
  readonly guild: Guild;
  readonly channel: Channel;
  readonly creatorId: string;
  readonly roleName: string;
  readonly days: number;
  /** Most temp roles one member may have active at once. */
  readonly maxActivePerMember: number;
}

/**
 * Marks a temp role apart from staff roles at a glance; a member cannot
 * name one to impersonate a moderator role.
 */
const TEMP_ROLE_PREFIX = '🔔 ';

/**
 * Post the claim message carrying the self-service toggle button. The
 * button reuses the existing `toggle_role|<roleId>` custom id so the
 * `toggle_role` button handler grants / revokes the role on click.
 * Returns the sent `Message`, or `null` when the channel is not
 * sendable.
 */
const announceTempRole = async (
  channel: Channel,
  role: Role,
  expiresAt: number,
  deps: TempRoleDeps,
): Promise<Message | null> => {
  if (!channel.isSendable()) return null;
  const t = bindTranslator(deps.translator);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`toggle_role|${role.id}`)
      .setLabel(t('replies:temp_role.button_label'))
      .setStyle(ButtonStyle.Primary),
  );
  const content = t('replies:temp_role.created', {
    role: `<@&${role.id}>`,
    expiry: discordTimestamp(expiresAt),
  });
  return (await channel.send({ content, components: [row] })) ?? null;
};

/** Discord's "Unknown Role": the role is already gone. */
const DISCORD_UNKNOWN_ROLE = 10011;

/**
 * Delete a Discord role, tolerating an already-removed role. Returns
 * whether the role is gone, so a refused deletion keeps its record.
 */
const deleteRoleQuietly = async (
  deps: TempRoleDeps,
  guild: Guild,
  roleId: string,
): Promise<boolean> => {
  try {
    await guild.roles.delete(roleId, AUDIT_REASON_EXPIRE);
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError && Number(error.code) === DISCORD_UNKNOWN_ROLE)
      return true;
    logError(deps.logger, guild.id, error);
    return false;
  }
};

/** Edit the claim message to its expired state and strip the button. */
const markMessageExpired = async (
  deps: TempRoleDeps,
  guild: Guild,
  doc: TempRoleDoc,
): Promise<void> => {
  try {
    const channel =
      guild.channels.cache.get(doc.channel_id) ??
      (await deps.client.channels.fetch(doc.channel_id).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(doc.message_id).catch(() => null);
    if (!message) return;
    const t = bindTranslator(deps.translator);
    await message.edit({
      content: t('replies:temp_role.expired', { role: doc.role_name }),
      components: [],
    });
  } catch (error) {
    logError(deps.logger, guild.id, error);
  }
};

/**
 * Expire a temporary role: delete the Discord role, mark the claim
 * message expired, and remove the DB row and job.
 *
 * A role already deleted by hand counts as gone. When Discord refuses
 * the deletion (for example, missing permissions) the row and job stay,
 * so the role is not left behind untracked; the next reboot sweep or
 * expiry retries. The DB delete throws on error for the same reason.
 *
 * @returns whether the role was removed.
 */
export const expireTempRole = async (
  deps: TempRoleDeps,
  guildId: string,
  roleId: string,
): Promise<boolean> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return false;

  const findResult = await repos.tempRole.findByRoleId(roleId);
  if (!findResult.ok) throw findResult.error;
  const doc = findResult.value;

  const guild = deps.client.guilds.cache.get(guildId);
  if (!guild || !(await deleteRoleQuietly(deps, guild, roleId))) return false;
  if (doc) await markMessageExpired(deps, guild, doc);

  const deleteResult = await repos.tempRole.deleteByRoleId(roleId);
  if (!deleteResult.ok) throw deleteResult.error;
  new JobManager(deps.jobMap).cancel(tempRoleJobKey(roleId));
  return true;
};

/** Run an expiry detached, routing any rejection to the logger. */
const runExpiryDetached = (deps: TempRoleDeps, guildId: string, roleId: string): void => {
  // A rejected expiry must be logged, not left as an unhandled rejection
  // inside a node-schedule timer or an immediate-expiry fallback.
  void expireTempRole(deps, guildId, roleId).catch((error) =>
    logError(deps.logger, guildId, error),
  );
};

/** Schedule (or replace) the one-shot expiry job for `roleId`. */
const scheduleExpiryJob = (
  deps: TempRoleDeps,
  guildId: string,
  roleId: string,
  when: Date,
): void => {
  // node-schedule fires on the real wall clock and returns null for a
  // past `Date` (it would never fire), which would silently store a null
  // job and leak a never-expiring role. If the deadline is already due —
  // a clock skew, or the narrow window between a reboot check and here —
  // expire immediately instead of scheduling.
  if (when.getTime() <= Date.now()) {
    runExpiryDetached(deps, guildId, roleId);
    return;
  }
  new JobManager(deps.jobMap, deps.logger).schedule(tempRoleJobKey(roleId), when, () =>
    runExpiryDetached(deps, guildId, roleId),
  );
};

const createTempRoleUnlocked = async (
  deps: TempRoleDeps,
  args: CreateTempRoleArgs,
): Promise<CreateTempRoleOutcome> => {
  const { guild, channel, creatorId, roleName, days } = args;

  if (guild.roles.cache.size >= MAX_GUILD_ROLES) {
    return { status: 'role_limit' };
  }

  const repos = deps.registry.getRepos(guild.id);
  if (!repos) return { status: 'no_db' };

  const fullName = `${TEMP_ROLE_PREFIX}${roleName}`;
  const existing = await repos.tempRole.listAll();
  if (!existing.ok) throw existing.error;
  const roleNames = new Set([
    ...[...guild.roles.cache.values()].map((role) => role.name.toLowerCase()),
    ...existing.value.map((doc) => doc.role_name.toLowerCase()),
  ]);
  const taken = (name: string): boolean => roleNames.has(name.toLowerCase());
  if (taken(roleName) || taken(fullName)) return { status: 'name_taken' };
  const active = existing.value.filter((doc) => doc.creator_id === creatorId).length;
  if (active >= args.maxActivePerMember) {
    return { status: 'too_many', max: args.maxActivePerMember };
  }

  const expiresAt = deps.clock.now() + days * MS_PER_DAY;

  let role: Role;
  try {
    role = await guild.roles.create({
      name: fullName,
      mentionable: true,
      permissions: [],
      reason: `${AUDIT_REASON_CREATE} by ${creatorId}`,
    });
  } catch (error) {
    if (error instanceof DiscordAPIError && Number(error.code) === DISCORD_MAX_ROLES_ERROR) {
      return { status: 'role_limit' };
    }
    throw error;
  }

  const message = await announceTempRole(channel, role, expiresAt, deps);
  if (message === null) {
    await deleteRoleQuietly(deps, guild, role.id);
    return { status: 'announce_failed' };
  }

  const createResult = await repos.tempRole.create({
    role_id: role.id,
    channel_id: channel.id,
    message_id: message.id,
    creator_id: creatorId,
    role_name: fullName,
    expires_at: expiresAt,
  });
  if (!createResult.ok) {
    // Without a persisted row the expiry job is never rebuilt on
    // restart, so roll back rather than leak a never-expiring role.
    await deleteRoleQuietly(deps, guild, role.id);
    await message.delete().catch(() => undefined);
    throw createResult.error;
  }

  scheduleExpiryJob(deps, guild.id, role.id, new Date(expiresAt));
  return { status: 'created', roleId: role.id, expiresAt };
};

const creationQueues = new Map<string, Promise<unknown>>();

/**
 * Create a temporary notification role, post its claim message, persist
 * the row, and schedule its expiry. The role is permission-less and
 * mentionable: its only purpose is to notify holders when `@mentioned`.
 *
 * Best-effort rollback keeps the three side effects consistent: if the
 * announcement or the DB write fails after the role exists, the orphan
 * role (and message) are removed so no never-expiring role is leaked.
 *
 * Security invariant: the command is open to every member *because* the
 * role it creates is powerless — `permissions: []`, `mentionable: true`.
 * That coupling is load-bearing; the guild ceiling and per-member cap
 * bound role creation. Granting the created role any permission makes
 * unrestricted creation a privilege-escalation path, so such a change
 * must revisit the open-access decision first.
 *
 * Creations per guild run one at a time, so two concurrent requests
 * cannot both pass the per-member cap or claim the same name.
 */
export const createTempRole = async (
  deps: TempRoleDeps,
  args: CreateTempRoleArgs,
): Promise<CreateTempRoleOutcome> => {
  const guildId = args.guild.id;
  const previous = creationQueues.get(guildId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => createTempRoleUnlocked(deps, args));
  creationQueues.set(guildId, run);
  try {
    return await run;
  } finally {
    if (creationQueues.get(guildId) === run) creationQueues.delete(guildId);
  }
};

/** Outcome of {@link cancelTempRole}. */
type CancelTempRoleOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'not_temp_role' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_db' };

/**
 * End a temp role early, as if it had expired. `canCancel` decides from
 * the role's creator whether the requester may.
 */
export const cancelTempRole = async (
  deps: TempRoleDeps,
  guildId: string,
  roleId: string,
  canCancel: (creatorId: string) => boolean,
): Promise<CancelTempRoleOutcome> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return { status: 'no_db' };
  const found = await repos.tempRole.findByRoleId(roleId);
  if (!found.ok) throw found.error;
  if (!found.value) return { status: 'not_temp_role' };
  if (!canCancel(found.value.creator_id)) return { status: 'forbidden' };
  const guild = deps.client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Cannot cancel a temporary role in unavailable guild ${guildId}`);
  try {
    await guild.roles.delete(roleId, AUDIT_REASON_EXPIRE);
  } catch (error) {
    // Keep the row and expiry job when Discord has not confirmed deletion.
    if (!(error instanceof DiscordAPIError && Number(error.code) === DISCORD_UNKNOWN_ROLE))
      throw error;
  }
  await markMessageExpired(deps, guild, found.value);
  const deleted = await repos.tempRole.deleteByRoleId(roleId);
  if (!deleted.ok) throw deleted.error;
  new JobManager(deps.jobMap).cancel(tempRoleJobKey(roleId));
  return { status: 'cancelled' };
};

const REBOOT_MAX_ATTEMPTS = 3;
const rebootRetry = <T>(op: () => Promise<T>): Promise<T> =>
  retryWithBackoff(op, REBOOT_MAX_ATTEMPTS);

/**
 * Rebuild every guild's expiry jobs on boot: re-schedule still-pending
 * roles and immediately expire any whose deadline already passed while
 * the process was down.
 */
export const rebootTempRoleJobs = async (
  deps: TempRoleDeps,
  recoveredGuildId?: string,
): Promise<void> => {
  const guildIds =
    recoveredGuildId === undefined ? deps.registry.listGuildIds() : [recoveredGuildId];
  await Promise.all(
    guildIds.map((guildId) =>
      withGuildContext(deps.translator, guildId, async () => {
        try {
          const repos = deps.registry.getRepos(guildId);
          if (!repos) return;
          const tempRoles = await rebootRetry(async () => {
            const result = await repos.tempRole.listAll();
            if (!result.ok) throw result.error;
            return result.value;
          });
          for (const tr of tempRoles) {
            try {
              if (tr.expires_at > deps.clock.now()) {
                scheduleExpiryJob(deps, guildId, tr.role_id, new Date(tr.expires_at));
              } else {
                await rebootRetry(() => expireTempRole(deps, guildId, tr.role_id));
              }
            } catch (rowErr) {
              logError(deps.logger, guildId, rowErr);
            }
          }
        } catch (err) {
          logError(deps.logger, guildId, err);
          const debugCh = deps.registry.getChannel(guildId, 'debug');
          if (debugCh?.isSendable()) {
            await debugCh
              .send(
                `[ ops ] temp-role reboot listAll failed for guild ${guildId} after ${REBOOT_MAX_ATTEMPTS} attempts; expiry jobs may be missing until next restart.`,
              )
              .catch((sendErr) => logError(deps.logger, guildId, sendErr));
          }
        }
      }),
    ),
  );
};
