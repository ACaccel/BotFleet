import { ChannelType, type Guild } from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import { safeArchiveName } from '../../../core/archive/progress';
import { publicArchiveSourceName } from '../../../infra/archive/public-message';

interface SourceTarget {
  channelId?: string;
  historicalName?: string;
  parentId?: string;
  sourceType?: number | string;
  identity?: string;
}

const displayName = (value: unknown, maximum: number): string => {
  const name = safeArchiveName(value);
  return name.length > maximum ? `${name.slice(0, Math.max(0, maximum - 3))}...` : name;
};

/** Cache resolution avoids REST calls and never equates missing access with deletion. */
export const archiveSourceLabel = (
  target: SourceTarget,
  guild: Guild | null | undefined,
  t: BoundTranslate,
  maxNameLength = 70,
): string => {
  const channel =
    target.channelId === undefined ? undefined : guild?.channels.cache.get(target.channelId);
  const publicName =
    guild?.client === undefined || target.channelId === undefined
      ? undefined
      : publicArchiveSourceName(guild.client, guild.id, target.channelId);
  const name = displayName(publicName, maxNameLength);
  const parentId = channel?.parentId ?? target.parentId;
  const parent = parentId === undefined ? undefined : guild?.channels.cache.get(parentId);
  const type = channel?.type ?? target.sourceType;
  const kind =
    type === ChannelType.GuildText || type === 'text'
      ? 'text'
      : type === ChannelType.GuildForum || type === 'forum'
        ? 'forum'
        : type === ChannelType.PublicThread ||
            type === ChannelType.PrivateThread ||
            type === ChannelType.AnnouncementThread ||
            type === 'thread'
          ? parent?.type === ChannelType.GuildForum
            ? 'forum-post'
            : 'thread'
          : type === ChannelType.GuildAnnouncement || type === 'announcement'
            ? 'announcement'
            : 'unknown';
  const label = name === '' ? t('replies:archive.source_unidentified') : `#${name}`;
  const origin = '';
  const parentName =
    guild?.client === undefined || parentId === undefined
      ? undefined
      : publicArchiveSourceName(guild.client, guild.id, parentId);
  const path =
    parentId === undefined
      ? ''
      : `${parentName === undefined ? parentId : `#${displayName(parentName, maxNameLength)}`} / `;
  return t('replies:archive.source_label', {
    path,
    name: label,
    kind: t(`replies:archive.source_type_${kind}`),
    origin,
    id: target.channelId ?? t('replies:archive.source_id_unknown'),
  });
};

export const archiveGuildLabel = (
  guild: Guild | null | undefined,
  guildId: string,
  maxNameLength = 100,
): string =>
  guild?.name === undefined ? guildId : `${displayName(guild.name, maxNameLength)} (ID ${guildId})`;
