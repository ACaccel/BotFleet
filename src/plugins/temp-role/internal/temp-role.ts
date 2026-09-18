/**
 * Temporary notification-role internals.
 *
 * Mirrors the giveaway plugin's shape: the public surface takes a typed
 * {@link TempRoleDeps} bundle rather than the whole `BaseBot`, so the
 * plugin can resolve its dependencies through the IoC container
 * (`ctx.resolve(...)`). The slash-command handler bridges a `BaseBot`
 * reference into this surface via `buildTempRoleDepsFromBot`.
 *
 * A temp role is a permission-less, mentionable Discord role created on
 * demand and auto-deleted at `expires_at`. State lives in MongoDB; the
 * one-shot expiry jobs are ephemeral and rebuilt on every boot
 * (`rebootTempRoleJobs`), exactly like the giveaway scheduler.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError } from 'discord.js';
import type { Channel, Client, Guild, Message, Role } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildRegistry } from '../../../bot/guild-registry';
import { bindTranslator, type Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import { JobManager } from '@core/scheduling';
import type { Clock } from '../../../core/time';
import type { TempRoleDoc } from '../../../persistence/schemas/temp-role.schema';

export interface TempRoleDeps {
  readonly client: Client;
  readonly registry: GuildRegistry;
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
const AUDIT_REASON_CREATE = 'Temporary notification role created via /temp_role';
const AUDIT_REASON_EXPIRE = 'Temporary notification role expired';

export const tempRoleJobKey = (roleId: string): string => `temp-role:${roleId}`;

/** Discord renders `<t:unix:f>` in each viewer's own locale and timezone. */
const discordTimestamp = (epochMs: number): string => `<t:${Math.floor(epochMs / 1000)}:f>`;

/** Outcome of {@link createTempRole}; the handler maps it to i18n copy. */
type CreateTempRoleOutcome =
  | { readonly status: 'created'; readonly roleId: string; readonly expiresAt: number }
  | { readonly status: 'role_limit' }
  | { readonly status: 'no_db' }
  | { readonly status: 'announce_failed' };

interface CreateTempRoleArgs {
  readonly guild: Guild;
  readonly channel: Channel;
  readonly creatorId: string;
  readonly roleName: string;
  readonly days: number;
}

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

/** Delete a Discord role, tolerating an already-removed role. */
const deleteRoleQuietly = async (
  deps: TempRoleDeps,
  guild: Guild,
  roleId: string,
): Promise<void> => {
  try {
    await guild.roles.delete(roleId, AUDIT_REASON_EXPIRE);
  } catch (error) {
    logError(deps.logger, guild.id, error);
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
 * Expire a temporary role: cancel its job, delete the Discord role,
 * mark the claim message expired, and remove the DB row.
 *
 * Discord-side cleanup is best-effort (the role may have been deleted
 * manually, the message removed, or permissions revoked); the DB delete
 * throws on error so a reboot sweep retries it.
 */
export const expireTempRole = async (
  deps: TempRoleDeps,
  guildId: string,
  roleId: string,
): Promise<void> => {
  new JobManager(deps.jobMap).cancel(tempRoleJobKey(roleId));

  const repos = deps.registry.getRepos(guildId);
  if (!repos) return;

  const findResult = await repos.tempRole.findByRoleId(roleId);
  if (!findResult.ok) throw findResult.error;
  const doc = findResult.value;

  const guild = deps.client.guilds.cache.get(guildId);
  if (guild) {
    await deleteRoleQuietly(deps, guild, roleId);
    if (doc) await markMessageExpired(deps, guild, doc);
  }

  const deleteResult = await repos.tempRole.deleteByRoleId(roleId);
  if (!deleteResult.ok) throw deleteResult.error;
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
 * That coupling is load-bearing, and the guild role ceiling is the only
 * abuse bound enforced. Granting the created role any permission makes
 * unrestricted creation a privilege-escalation path, so such a change
 * must revisit the open-access decision first.
 */
export const createTempRole = async (
  deps: TempRoleDeps,
  args: CreateTempRoleArgs,
): Promise<CreateTempRoleOutcome> => {
  const { guild, channel, creatorId, roleName, days } = args;

  if (guild.roles.cache.size >= MAX_GUILD_ROLES) {
    return { status: 'role_limit' };
  }

  const repos = deps.registry.getRepos(guild.id);
  if (!repos) return { status: 'no_db' };

  const expiresAt = deps.clock.now() + days * MS_PER_DAY;

  let role: Role;
  try {
    role = await guild.roles.create({
      name: roleName,
      mentionable: true,
      permissions: [],
      reason: AUDIT_REASON_CREATE,
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
    role_name: roleName,
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

/**
 * Same exponential-backoff retry as the giveaway / activity reboot.
 * Without it a transient Mongo blip during boot would silently leave a
 * guild's temp roles un-rebuilt for the process lifetime.
 */
const REBOOT_MAX_ATTEMPTS = 3;
const rebootRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < REBOOT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt < REBOOT_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
};

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
    guildIds.map(async (guildId) => {
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
  );
};
