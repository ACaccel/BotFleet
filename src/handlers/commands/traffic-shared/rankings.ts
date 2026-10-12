/**
 * Ranking columns and named rows shared by the activity reports: members,
 * channels (with forum posts tagged by their forum), and the top-messages text
 * wiring that resolves names from the live guild and the archive records.
 */
import type {
  AuthorRanking,
  ChannelRanking,
  TopReactedMessage,
} from '../../../persistence/repositories/archive-stats.types';

import { restNote } from './activity-sections';
import type { RankingColumn, RankRow } from './dashboard';
import { hotMessagesText, type MentionNames } from './hot-messages';
import { channelName, channelRecordsOf, memberName, type ChannelRecords } from './names';
import type { TrafficContext } from './run';

const K = 'replies:traffic';

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Ranking titles name the rows actually shown, e.g. "Top 7" when only seven members posted. */
const titled = (context: TrafficContext, titleKey: string, rows: number): string =>
  context.t(titleKey, { n: rows });

export const memberColumn = (
  context: TrafficContext,
  titleKey: string,
  authors: AuthorRanking,
): RankingColumn => {
  const unknown = context.t(`${K}.unknown_member`);
  const rows = authors.rows.map((row) => ({
    name: memberName(context.guild, row.userId, row, unknown),
    value: row.messages,
  }));
  const note = restNote(
    context.t,
    'rest_members',
    authors.distinct - rows.length,
    authors.total - sum(rows.map((row) => row.value)),
  );
  return {
    title: titled(context, titleKey, rows.length),
    rows,
    ...(note === undefined ? {} : { note }),
  };
};

/** A channel or thread row: the live or recorded name, and its forum as a tag for a post. */
export const channelRow = (
  context: TrafficContext,
  records: ChannelRecords,
  row: ChannelRanking['rows'][number],
): RankRow => {
  const { t, guild } = context;
  const name = channelName(guild, records, row.channelId, row.name) ?? t(`${K}.unknown_channel`);
  if (row.forum === undefined) return { name, value: row.messages };
  const forum = channelName(guild, records, row.forum.channelId, row.forum.name);
  return {
    name,
    value: row.messages,
    ...(forum === undefined ? {} : { tag: t(`${K}.forum_tag`, { name: forum }) }),
  };
};

export const channelColumn = (
  context: TrafficContext,
  titleKey: string,
  ranking: ChannelRanking,
  rowFor: (row: ChannelRanking['rows'][number]) => RankRow,
  itemsKey = 'rest_channels',
): RankingColumn => {
  const rows = ranking.rows.map(rowFor);
  const note = restNote(
    context.t,
    itemsKey,
    ranking.distinct - rows.length,
    ranking.total - sum(rows.map((row) => row.value)),
  );
  return {
    title: titled(context, titleKey, rows.length),
    rows,
    ...(note === undefined ? {} : { note }),
  };
};

/** Names for mentions in previews; a channel the reply may not count stays unnamed. */
const mentionNames = (context: TrafficContext, records: ChannelRecords): MentionNames => {
  const { guild, t } = context;
  const unknownMember = t(`${K}.unknown_member`);
  return {
    user: (id) =>
      guild.members.cache.get(id)?.displayName ??
      guild.client.users.cache.get(id)?.username ??
      unknownMember,
    role: (id) => guild.roles.cache.get(id)?.name ?? t(`${K}.unknown_role`),
    channel: (id) =>
      (context.visible.has(id) ? channelName(guild, records, id) : undefined) ??
      t(`${K}.unknown_channel`),
  };
};

export const topMessagesText = (
  context: TrafficContext,
  messages: readonly TopReactedMessage[],
): string | undefined => {
  const records = channelRecordsOf(context.records);
  const unknown = context.t(`${K}.unknown_member`);
  return hotMessagesText({
    messages,
    guildId: context.guild.id,
    names: mentionNames(context, records),
    author: (message) => memberName(context.guild, message.author.id, message.author, unknown),
    timeZone: context.period.timeZone,
    t: context.t,
  });
};
