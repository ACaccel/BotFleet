/**
 * Report assembly of the archive statistics reader: plans the facets an activity
 * query needs and turns raw facet rows into result objects. Pure; the Mongo
 * driver calls live in `archive-stats.repo.ts`.
 */
import {
  attributeChannel,
  assertTimeZone,
  bucketKeyOf,
  bucketKeysOf,
  localSlotOf,
  longestDayStreak,
  type ArchiveChannelInfo,
  type StatsGranularity,
  type StatsWindow,
} from '../../core/archive/stats';
import { facetName, QUARTER_HOUR_MS, type ActivityPlan } from './archive-stats.pipelines';
import type {
  ActivityHeatmap,
  ActivityResults,
  AnyActivityQuery,
  AppUsageOptions,
  AppUsageStats,
  ChannelActivity,
  ReactionCount,
  ReplyPartner,
  ReplyPartnersStats,
  TopReactedMessage,
  TrendBucket,
} from './archive-stats.types';

const DEFAULT_LIMIT = 10;

export type Row = Record<string, unknown>;
export type FacetOutput = Record<string, Row[] | undefined>;

export const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
export const record = (value: unknown): Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map((entry: unknown) => record(entry)) : [];

export const assertWindow = (window: StatsWindow, name: string): void => {
  if (
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endMs) ||
    window.startMs >= window.endMs
  )
    throw new TypeError(`${name}: invalid window [${window.startMs}, ${window.endMs})`);
};
export const resolveLimit = (limit: number | undefined, name: string): number => {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0)
    throw new TypeError(`${name}: limit must be a positive integer, got ${value}`);
  return value;
};

export const reactionCount = (key: string, emoji: Row, count: number): ReactionCount => {
  const emojiId = text(emoji.id);
  const name = text(emoji.name);
  return {
    key,
    ...(emojiId === undefined ? {} : { emojiId }),
    ...(name === undefined ? {} : { name }),
    ...(typeof emoji.animated === 'boolean' ? { animated: emoji.animated } : {}),
    count,
  };
};
const userNames = (value: unknown): { username?: string; globalName?: string } => {
  const names = record(value);
  const username = text(names.username);
  const globalName = text(names.globalName);
  return {
    ...(username === undefined ? {} : { username }),
    ...(globalName === undefined ? {} : { globalName }),
  };
};
/** Quarter-hour counts keyed by the quarter's start time; `current` selects the window. */
const quarterCounts = (
  raw: readonly Row[],
  valueField: string,
  current = true,
): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const row of raw) {
    const id = record(row._id);
    const quarter = typeof row._id === 'number' ? row._id : num(id.quarter);
    if (typeof row._id !== 'number' && id.current !== current) continue;
    counts.set(quarter * QUARTER_HOUR_MS, num(row[valueField]));
  }
  return counts;
};

/**
 * Sums quarter-hour counts of one window into its zero-filled local buckets. Local
 * bucket bounds fall on quarter hours, so a quarter that starts before the window
 * still belongs to the window's first bucket.
 */
const localTrend = (
  window: StatsWindow,
  granularity: StatsGranularity,
  timeZone: string,
  quarters: ReadonlyMap<number, number>,
): { key: string; count: number }[] => {
  const counts = new Map(bucketKeysOf(window, granularity, timeZone).map((key) => [key, 0]));
  for (const [at, count] of quarters) {
    const key = bucketKeyOf(Math.max(at, window.startMs), granularity, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return [...counts].map(([key, count]) => ({ key, count }));
};

/** Weekday x local-hour counts from quarter-hour counts. */
const heatmapOf = (quarters: ReadonlyMap<number, number>, timeZone: string): ActivityHeatmap => {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const [at, count] of quarters) {
    const slot = localSlotOf(at, timeZone);
    const day = cells[slot.weekday];
    if (day !== undefined) day[slot.hour] = (day[slot.hour] ?? 0) + count;
  }
  return { cells };
};

/**
 * The facets an activity query needs. Exported so the integration tests can
 * `explain()` the exact pipeline the repository runs.
 */
export const planActivity = (
  query: AnyActivityQuery,
  operation = 'MongoArchiveStatsRepo.activity',
): ActivityPlan => {
  const { window, previousWindow, timeZone, sections } = query;
  assertWindow(window, operation);
  if (previousWindow !== undefined) assertWindow(previousWindow, operation);
  assertTimeZone(timeZone);
  if (!Object.values(sections).some((section) => section !== undefined))
    throw new TypeError(`${operation}: request at least one section`);
  if (sections.retention !== undefined && previousWindow === undefined)
    throw new TypeError(`${operation}: retention requires previousWindow`);
  const filterOf = (section: { readonly authorId?: string } | undefined): string =>
    section?.authorId ?? '';
  const unique = (values: readonly (string | undefined)[]): string[] => [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ];
  const summaryFilter = sections.summary && filterOf(sections.summary);
  const channels = unique([summaryFilter, sections.channels && filterOf(sections.channels)]).map(
    (filter) => ({ filter, totals: filter === summaryFilter }),
  );
  const time = unique([
    sections.trend && filterOf(sections.trend),
    sections.heatmap && filterOf(sections.heatmap),
    sections.activeDays?.userId,
  ]);
  const reactions = unique([sections.reactions && filterOf(sections.reactions)]);
  // Everyone's author group: rankings, retention and the guild-wide member count.
  const needsAuthors =
    sections.authors !== undefined ||
    sections.retention !== undefined ||
    (sections.summary !== undefined && sections.summary.authorId === undefined);
  const filters = [...new Set([...channels.map((entry) => entry.filter), ...time, ...reactions])];
  // Limits applied in memory are still validated up front, before the query runs.
  if (sections.channels) resolveLimit(sections.channels.limit, operation);
  if (sections.reactions) resolveLimit(sections.reactions.limit, operation);
  if (sections.partners) resolveLimit(sections.partners.limit, operation);
  return {
    window,
    ...(previousWindow === undefined ? {} : { previousWindow }),
    channels,
    time,
    reactions,
    filters,
    ...(needsAuthors && {
      authors: {
        limit: resolveLimit(sections.authors?.limit, operation),
        ...(sections.authors?.rankOf === undefined ? {} : { rankOf: sections.authors.rankOf }),
      },
    }),
    ...(sections.partners && {
      partners: {
        userId: sections.partners.userId,
        excludeUserIds: sections.partners.excludeUserIds ?? [],
      },
    }),
    ...(sections.topMessages && {
      topMessages: { limit: resolveLimit(sections.topMessages.limit, operation) },
    }),
  };
};

/** Derives every requested section from the facet output of one activity query. */
export const buildReport = (
  query: AnyActivityQuery,
  plan: ActivityPlan,
  output: FacetOutput,
  lookup: ReadonlyMap<string, ArchiveChannelInfo>,
): Partial<ActivityResults> => {
  const { sections, window, previousWindow, timeZone } = query;
  const facet = (kind: string, filter: string): Row[] =>
    output[facetName(kind, filter, plan.filters)] ?? [];
  const filterOf = (section: { readonly authorId?: string }): string => section.authorId ?? '';
  const authors = record(output.authors?.[0]);
  const quartersOf = (filter: string, current = true): Map<number, number> =>
    quarterCounts(facet('time', filter), 'messages', current);
  const report: Partial<ActivityResults> = {};

  if (sections.summary) {
    const filter = filterOf(sections.summary);
    const perChannel = facet('channels', filter);
    const sum = (field: string): number =>
      perChannel.reduce((total, row) => total + num(row[field]), 0);
    const messages = sum('messages');
    report.summary = {
      messages,
      activeMembers: filter === '' ? num(authors.currentMembers) : Math.min(messages, 1),
      activeChannels: foldChannels(perChannel, lookup).length,
      edited: sum('edited'),
      content: {
        media: sum('media'),
        files: sum('files'),
        voice: sum('voice'),
        links: sum('links'),
        stickers: sum('stickers'),
        polls: sum('polls'),
        forwards: sum('forwards'),
        replies: sum('replies'),
      },
      ...(previousWindow === undefined ? {} : { previousMessages: sum('previous') }),
    };
  }
  if (sections.trend) {
    const { granularity } = sections.trend;
    const filter = filterOf(sections.trend);
    const trendOf = (range: StatsWindow, current: boolean): TrendBucket[] =>
      localTrend(range, granularity, timeZone, quartersOf(filter, current)).map(
        ({ key, count }) => ({ key, messages: count }),
      );
    report.trend = {
      granularity,
      current: trendOf(window, true),
      ...(previousWindow === undefined ? {} : { previous: trendOf(previousWindow, false) }),
    };
  }
  if (sections.heatmap)
    report.heatmap = heatmapOf(quartersOf(filterOf(sections.heatmap)), timeZone);
  if (sections.activeDays) {
    const days = new Set<string>();
    for (const [at, count] of quartersOf(sections.activeDays.userId))
      if (count > 0) days.add(localSlotOf(at, timeZone).dayKey);
    const dayKeys = [...days].sort();
    report.activeDays = {
      activeDays: dayKeys.length,
      longestStreak: longestDayStreak(dayKeys),
      dayKeys,
    };
  }
  if (sections.channels) {
    const limit = resolveLimit(sections.channels.limit, 'MongoArchiveStatsRepo.activity');
    const raw = facet('channels', filterOf(sections.channels));
    const all =
      sections.channels.fold === false
        ? raw
            .filter((row) => num(row.messages) > 0)
            .map((row) =>
              describeChannel({ channelId: String(row._id) }, num(row.messages), lookup),
            )
            .sort(byMessages)
        : foldChannels(raw, lookup);
    report.channels = {
      rows: all.slice(0, limit),
      distinct: all.length,
      total: all.reduce((sum, row) => sum + row.messages, 0),
    };
  }
  if (sections.authors) {
    const rankOf = sections.authors.rankOf;
    const subject = record(authors.subject);
    report.authors = {
      rows: rows(authors.top)
        .filter((row) => num(row.messages) > 0)
        .map((row) => ({
          userId: String(row.userId),
          messages: num(row.messages),
          ...userNames(row.name),
        })),
      distinct: num(authors.currentMembers),
      total: num(authors.currentTotal),
      ...(rankOf === undefined
        ? {}
        : {
            subject: {
              userId: rankOf,
              rank: typeof subject.rank === 'number' ? subject.rank : null,
              messages: num(subject.messages),
            },
          }),
    };
  }
  if (sections.reactions) {
    const counts = facet('reactions', filterOf(sections.reactions))
      .map((row) => reactionCount(String(row._id), record(row.emoji), num(row.count)))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    report.reactions = {
      total: counts.reduce((sum, row) => sum + row.count, 0),
      top: counts.slice(
        0,
        resolveLimit(sections.reactions.limit, 'MongoArchiveStatsRepo.activity'),
      ),
    };
  }
  if (sections.retention) {
    const previous = num(authors.previousMembers);
    const current = num(authors.currentMembers);
    const retained = num(authors.retained);
    report.retention = {
      previousMembers: previous,
      currentMembers: current,
      retained,
      returningOrNew: current - retained,
      retentionRate: previous === 0 ? null : retained / previous,
    };
  }
  if (sections.partners)
    report.partners = buildPartners(
      output,
      resolveLimit(sections.partners.limit, 'MongoArchiveStatsRepo.activity'),
    );
  if (sections.topMessages) report.topMessages = (output.topMessages ?? []).map(topMessage);
  return report;
};

const byMessages = (a: ChannelActivity, b: ChannelActivity): number =>
  b.messages - a.messages || a.channelId.localeCompare(b.channelId);

const describeChannel = (
  attribution: { readonly channelId: string; readonly forumId?: string },
  messages: number,
  lookup: ReadonlyMap<string, ArchiveChannelInfo>,
): ChannelActivity => {
  const info = lookup.get(attribution.channelId);
  const forum =
    attribution.forumId === undefined
      ? undefined
      : { channelId: attribution.forumId, name: lookup.get(attribution.forumId)?.name };
  return {
    channelId: attribution.channelId,
    messages,
    ...(info?.name === undefined ? {} : { name: info.name }),
    ...(info?.type === undefined ? {} : { type: info.type }),
    deleted: info?.access === 'deleted',
    ...(forum === undefined
      ? {}
      : {
          forum: {
            channelId: forum.channelId,
            ...(forum.name === undefined ? {} : { name: forum.name }),
          },
        }),
  };
};

/** Per-channel counts folded by the channel attribution rule, highest first. */
const foldChannels = (
  raw: readonly Row[],
  lookup: ReadonlyMap<string, ArchiveChannelInfo>,
): ChannelActivity[] => {
  const folded = new Map<string, { forumId?: string; messages: number }>();
  for (const row of raw) {
    // A channel active only in the previous window has no row in this one.
    if (num(row.messages) === 0) continue;
    const attribution = attributeChannel(String(row._id), (id) => lookup.get(id));
    const entry = folded.get(attribution.channelId) ?? {
      ...(attribution.forumId === undefined ? {} : { forumId: attribution.forumId }),
      messages: 0,
    };
    entry.messages += num(row.messages);
    folded.set(attribution.channelId, entry);
  }
  return [...folded]
    .map(([channelId, entry]) =>
      describeChannel(
        { channelId, ...(entry.forumId === undefined ? {} : { forumId: entry.forumId }) },
        entry.messages,
        lookup,
      ),
    )
    .sort(byMessages);
};

const buildPartners = (output: FacetOutput, limit: number): ReplyPartnersStats => {
  const partners = new Map<string, Omit<ReplyPartner, 'total'>>();
  const partner = (userId: string): Omit<ReplyPartner, 'total'> =>
    partners.get(userId) ?? {
      userId,
      repliesTo: 0,
      repliesFrom: 0,
      mentionsTo: 0,
      mentionsFrom: 0,
    };
  for (const row of output.partnersOut ?? []) {
    const userId = String(row._id);
    partners.set(userId, {
      ...partner(userId),
      repliesTo: num(row.repliesTo),
      mentionsTo: num(row.mentionsTo),
    });
  }
  for (const row of output.partnersIn ?? []) {
    const userId = String(row._id);
    partners.set(userId, {
      ...partner(userId),
      repliesFrom: num(row.repliesFrom),
      mentionsFrom: num(row.mentionsFrom),
    });
  }
  const all = [...partners.values()]
    .map((entry) => ({
      ...entry,
      total: entry.repliesTo + entry.repliesFrom + entry.mentionsTo + entry.mentionsFrom,
    }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
  const sum = (field: 'repliesTo' | 'repliesFrom' | 'mentionsTo' | 'mentionsFrom'): number =>
    all.reduce((total, entry) => total + entry[field], 0);
  return {
    partners: all.slice(0, limit),
    totals: {
      repliesSent: sum('repliesTo'),
      repliesReceived: sum('repliesFrom'),
      mentionsSent: sum('mentionsTo'),
      mentionsReceived: sum('mentionsFrom'),
    },
  };
};

const topMessage = (row: Row): TopReactedMessage => {
  const author = record(row.author);
  const content = text(row.content);
  const pollQuestion = text(record(record(row.poll).question).text);
  const forwardedContent = text(record(rows(row.messageSnapshots)[0]).content);
  const reactions = rows(row.reactions)
    .map((reaction) => {
      const emoji = record(reaction.emoji);
      const key = text(emoji.id) ?? text(emoji.name);
      return key === undefined ? undefined : reactionCount(key, emoji, num(reaction.count));
    })
    .filter((reaction): reaction is ReactionCount => reaction !== undefined)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    messageId: String(row._id),
    channelId: String(row.channelId),
    createdTimestamp: num(row.createdTimestamp),
    author: { id: String(author.id), ...userNames(author) },
    ...(content === undefined ? {} : { content }),
    ...(typeof row.flags === 'number' ? { flags: row.flags } : {}),
    edited: typeof row.editedTimestamp === 'number',
    attachments: rows(row.attachments).map((attachment) => {
      const contentType = text(attachment.contentType);
      const name = text(attachment.name);
      return {
        ...(contentType === undefined ? {} : { contentType }),
        ...(name === undefined ? {} : { name }),
      };
    }),
    stickers: rows(row.stickers).map((sticker) => {
      const id = text(sticker.id);
      const name = text(sticker.name);
      return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) };
    }),
    ...(pollQuestion === undefined ? {} : { pollQuestion }),
    ...(forwardedContent === undefined ? {} : { forwardedContent }),
    totalReactions: num(row.totalReactions),
    reactions,
  };
};

/** Result of {@link appUsagePipeline}'s facets. */
export const buildAppUsage = (
  output: FacetOutput,
  window: StatsWindow,
  options: AppUsageOptions,
): AppUsageStats => {
  const totals = record(output.totals?.[0]);
  const firstRecordAt = totals.firstAt;
  const quarters = quarterCounts(rows(output.time), 'uses');
  const trend =
    options.trend === undefined
      ? undefined
      : localTrend(window, options.trend.granularity, options.trend.timeZone, quarters).map(
          ({ key, count }) => ({ key, uses: count }),
        );
  return {
    uses: num(totals.uses),
    users: num(totals.users),
    ...(typeof firstRecordAt === 'number' ? { firstRecordAt } : {}),
    apps: rows(output.apps).map((row) => ({
      applicationId: String(row._id),
      ...userNames(row.name),
      uses: num(row.uses),
      commands: num(row.commands),
      components: num(row.components),
      modals: num(row.modals),
      users: num(row.users),
    })),
    topUsers: rows(output.users).map((row) => ({ userId: String(row._id), uses: num(row.uses) })),
    ...(trend === undefined ? {} : { trend }),
    ...(options.heatmap === undefined
      ? {}
      : { heatmap: heatmapOf(quarters, options.heatmap.timeZone) }),
  };
};
