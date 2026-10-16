/** The `/db stats` reply. */
import { EmbedBuilder, escapeMarkdown } from 'discord.js';

import type { CollectionStatsEntry } from '../../../application/db-inspect/service';
import type { BoundTranslate } from '../../../core/i18n';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';

import { dbReply, formatBytes, formatCount, joinLines, type DbReply } from './text';

export const buildStatsReply = (
  entries: readonly CollectionStatsEntry[],
  guild: string,
  t: BoundTranslate,
): DbReply => {
  const unregistered = t('replies:db_inspect.unregistered');
  const lines = entries.map((entry) =>
    t('replies:db_inspect.stats.line', {
      name: entry.registered ? entry.name : `${entry.name} (${unregistered})`,
      count: formatCount(entry.count),
      size: formatBytes(entry.storageSize),
      indexes: entry.indexCount,
    }),
  );
  const totalSize = entries.reduce((sum, entry) => sum + entry.storageSize + entry.indexSize, 0);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:db_inspect.stats.title'))
    .setDescription(
      joinLines([
        t('replies:db_inspect.guild', { guild: escapeMarkdown(guild) }),
        t('replies:db_inspect.stats.total', {
          collections: entries.length,
          size: formatBytes(totalSize),
        }),
        '',
        ...(lines.length === 0 ? [t('replies:db_inspect.stats.empty')] : lines),
      ]),
    );
  return dbReply([embed]);
};
