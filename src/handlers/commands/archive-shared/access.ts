import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import type { BaseBot } from '@bot';
import { asGuildId } from '../../../core/ids';
import { ARCHIVE_DEFAULT_INTERVAL_MS } from '../../../core/archive/limits';
import { ArchiveAccessError, ConfigurationError } from '../../../core/errors';
import type { ArchiveControl } from '../../../application/archive/control';

export const archiveConfig = z.object({
  backup_server: z.array(z.string().min(1)),
  backup_interval_minutes: z.number().int().positive().max(35_791).optional(),
  archive_policy: z.record(z.unknown()).optional(),
});
export interface ArchiveAccess {
  readonly guildId: string;
  readonly guildName: string;
  readonly control: ArchiveControl;
}

/**
 * Every `/archive` command and button: the operator must be in the bot's `admin`
 * list (guild owners and Manage Server holders are not implied), in the guild's
 * configured debug channel, in a guild listed in `backup_server`, on msg-archive.
 */
export const requireArchiveAccess = async (
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  bot: BaseBot,
): Promise<ArchiveAccess> => {
  const guild = interaction.guild;
  if (guild === null) throw new ArchiveAccessError('replies:archive.guild_only');
  // A guild whose database failed at startup has no archive to control.
  const disabled = bot.connectionManager?.isDisabled(asGuildId(guild.id));
  if (disabled !== undefined)
    throw new ArchiveAccessError('errors:db.guild_disabled', { traceId: disabled.traceId });
  if (!bot.isAdmin(interaction.user.id))
    throw new ArchiveAccessError('replies:archive.permission_denied');
  const parsed = archiveConfig.safeParse(bot.config);
  if (!parsed.success)
    throw new ConfigurationError({
      code: 'INVALID_CONFIG_JSON',
      messageKey: 'replies:archive.failed',
      context: { operation: 'requireArchiveAccess', input: { guildId: guild.id } },
      cause: parsed.error,
    });
  const config = parsed.data;
  if (!config.backup_server.includes(guild.id))
    throw new ArchiveAccessError('replies:archive.guild_not_configured');
  const debugId = bot.config.guilds?.[guild.id]?.channels?.['debug'];
  if (debugId === undefined || interaction.channelId !== debugId)
    throw new ArchiveAccessError('replies:archive.debug_only');
  const channel = guild.channels.cache.get(debugId) ?? (await guild.channels.fetch(debugId));
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const permissions = channel?.permissionsFor(me);
  if (
    channel === null ||
    channel === undefined ||
    !channel.isSendable() ||
    ![
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ].every((permission) => permissions?.has(permission) === true)
  )
    throw new ArchiveAccessError('replies:archive.debug_permissions');
  const unsupported = (): ConfigurationError =>
    new ConfigurationError({
      code: 'UNSUPPORTED_FEATURE',
      messageKey: 'replies:archive.failed',
      context: { operation: 'requireArchiveAccess', input: { guildId: guild.id } },
    });
  if (bot.connectionManager === undefined) throw unsupported();
  const connection = await bot.connectionManager.getConnection(asGuildId(guild.id));
  if (connection.archiveOwner !== 'msg-archive')
    throw new ArchiveAccessError('replies:archive.worker_only');
  // The msg-archive composition root registers the factory with archive ownership.
  const createControl = bot.archiveControlFactory;
  if (createControl === undefined) throw unsupported();
  return {
    guildId: guild.id,
    guildName: guild.name,
    control: createControl({
      guild: connection,
      defaultIntervalMs:
        config.backup_interval_minutes === undefined
          ? ARCHIVE_DEFAULT_INTERVAL_MS
          : config.backup_interval_minutes * 60_000,
    }),
  };
};
