import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';

/** Fail closed when the archived source is deleted, inaccessible or private. */
export const canReadArchiveSource = async (
  guild: Guild,
  channelId: string,
  userId: string,
): Promise<boolean> => {
  try {
    const [channel, member] = await Promise.all([
      guild.channels.fetch(channelId, { force: true }),
      guild.members.fetch(userId),
    ]);
    if (channel === null || !channel.isTextBased()) return false;
    const permissions = channel.permissionsFor(member);
    if (
      !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
    ) {
      return false;
    }
    if (
      (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) &&
      !permissions.has(PermissionFlagsBits.Connect)
    )
      return false;
    if (
      channel.type === ChannelType.PrivateThread &&
      !permissions.has(PermissionFlagsBits.ManageThreads)
    ) {
      const membership = await channel.members.fetch(userId);
      if (membership.id !== userId) return false;
    }
    return true;
  } catch {
    return false;
  }
};
