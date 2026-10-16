import { ChannelType, PermissionFlagsBits, type Client, type SendableChannels } from 'discord.js';
import type { GuildRegistry } from '../../../bot/guild-registry';
import type { GuildSettingsRuntime } from '../../../core/guild-settings';

interface EarthquakeDestination {
  readonly channel: SendableChannels;
  readonly roleId: string | undefined;
}

/** Missing server preferences never fall back to deployment destinations. */
export const resolveEarthquakeDestination = async (
  client: Client,
  registry: Pick<GuildRegistry, 'getChannel' | 'getRole'>,
  guildId: string,
  kind: 'alerts' | 'reports',
  settings?: GuildSettingsRuntime,
): Promise<EarthquakeDestination | undefined> => {
  if (settings === undefined) {
    const channel = registry.getChannel(guildId, 'earthquake');
    return channel?.isSendable()
      ? {
          channel,
          roleId: kind === 'alerts' ? registry.getRole(guildId, 'earthquake')?.id : undefined,
        }
      : undefined;
  }
  const snapshot = settings.get(guildId);
  const preference = snapshot?.settings.earthquake;
  if (
    !preference?.[kind === 'alerts' ? 'alertsEnabled' : 'reportsEnabled'] ||
    !preference.channelId
  )
    return undefined;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return undefined;
  const channel = await guild.channels.fetch(preference.channelId);
  const member = guild.members.me ?? (await guild.members.fetchMe());
  if (
    !channel ||
    channel.guildId !== guildId ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
    !channel.isSendable() ||
    !channel
      .permissionsFor(member)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ])
  )
    return undefined;
  let roleId: string | undefined;
  if (kind === 'alerts' && preference.roleId && preference.roleId !== guildId) {
    const role = await guild.roles.fetch(preference.roleId);
    if (role?.guild.id === guildId) roleId = role.id;
  }
  if (settings.get(guildId) !== snapshot) return undefined;
  return { channel, roleId };
};
