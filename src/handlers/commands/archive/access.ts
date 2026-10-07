import type { Connection } from 'mongoose';
import { createHash } from 'node:crypto';
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  SendableChannels,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import type { BaseBot } from '@bot';
import { asGuildId } from '../../../core/ids';
import { ArchivePolicySchema } from '../../../core/archive/policy';
import { ArchiveControlService } from '../../../infra/archive/control';

export const archiveConfig = z.object({
  backup_server: z.array(z.string().min(1)),
  backup_interval_minutes: z.number().int().positive().max(35_791).optional(),
  archive_policy: z.record(z.unknown()).optional(),
});
export class ArchiveAccessError extends Error {
  constructor(public readonly key: string) {
    super(key);
  }
}
type ArchiveInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | AutocompleteInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

export interface ArchiveAccess {
  guildId: string;
  control: ArchiveControlService;
  connection: Connection;
  config: z.infer<typeof archiveConfig>;
  debugId: string;
  channel: SendableChannels;
}

/** Public operation reports may be posted only after this gate has passed. */
export const requireArchiveAccess = async (
  interaction: ArchiveInteraction,
  bot: BaseBot,
): Promise<ArchiveAccess> => {
  const guild = interaction.guild;
  if (guild === null) throw new ArchiveAccessError('replies:archive.guild_only');
  if (
    guild.ownerId !== interaction.user.id &&
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true
  )
    throw new ArchiveAccessError('replies:archive.permission_denied');
  const config = archiveConfig.parse(bot.config);
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
  if (bot.connectionManager === undefined)
    throw new Error('Archive connection manager is unavailable.');
  const connection = await bot.connectionManager.getConnection(asGuildId(guild.id));
  if (connection.archiveOwner !== 'msg-archive')
    throw new ArchiveAccessError('replies:archive.worker_only');
  const policy = ArchivePolicySchema.parse({
    ...(config.archive_policy ?? {}),
    guildIds: config.backup_server,
  });
  const control = new ArchiveControlService(connection.connection, guild.id, {
    policyHash: () => createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  });
  return {
    guildId: guild.id,
    control,
    connection: connection.connection,
    config,
    debugId,
    channel,
  };
};
