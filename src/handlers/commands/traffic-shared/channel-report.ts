/**
 * `/traffic channel`: one channel's member activity, optionally with the threads
 * under it. A channel outside the invoker's visible set (including one the
 * `public` ceiling excludes) gets the same answer as a channel that does not
 * exist, so the reply never reveals whether it does.
 */
import { bucketKeysOf, THREAD_CHANNEL_TYPES } from '../../../core/archive/stats';
import type { ActivityHeatmap } from '../../../persistence/repositories/archive-stats.types';

import { dailyAverage, heroOf, trendOf } from './activity-common';
import { busiestTile, heatmapOf, retentionTiles } from './activity-sections';
import { formatCount, renderChannelDashboard, type RankingColumn } from './dashboard';
import { rangeLabel, weekdayLabels, weekdayOf } from './labels';
import { channelName, channelRecordsOf } from './names';
import type { Period } from './period';
import { channelColumn, channelRow, memberColumn, topMessagesText } from './rankings';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';
import { contentSection, serverInteractions } from './server-sections';
import type { TFn } from './types';

const K = 'replies:traffic';
const TOP_MESSAGES = 3;

/** The visible threads whose recorded or cached parent is `channelId`. */
const visibleThreadsOf = (context: TrafficContext, channelId: string): string[] => {
  const threads = new Set<string>();
  for (const record of context.records)
    if (record.parentId === channelId && THREAD_CHANNEL_TYPES.has(record.type ?? -1))
      threads.add(record.channelId);
  for (const [id, channel] of context.guild.channels.cache)
    if (channel.isThread() && channel.parentId === channelId) threads.add(id);
  return [...threads].filter((id) => context.visible.has(id));
};

/** Average messages per weekday: the right column when there are no threads to rank. */
const weekdayAverages = (t: TFn, period: Period, heatmap: ActivityHeatmap): RankingColumn => {
  const days = Array.from({ length: 7 }, () => 0);
  for (const key of bucketKeysOf(period.window, 'day', period.timeZone)) {
    const day = weekdayOf(key);
    days[day] = (days[day] ?? 0) + 1;
  }
  const labels = weekdayLabels(t);
  return {
    title: t(`${K}.weekday_average_title`),
    ranked: false,
    rows: heatmap.cells.map((hours, day) => ({
      name: labels[day] ?? '',
      value: Math.round(hours.reduce((a, b) => a + b, 0) / Math.max(1, days[day] ?? 0)),
    })),
  };
};

export const buildChannelReport = async (
  context: TrafficContext,
  channelId: string,
  includeThreads: boolean,
): Promise<TrafficOutcome> => {
  const { t, period, options, guild } = context;
  if (!context.visible.has(channelId)) return { kind: 'notice', key: `${K}.channel_not_found` };
  const records = channelRecordsOf(context.records);
  const type = guild.channels.cache.get(channelId)?.type ?? records.get(channelId)?.type;
  const isThread = type !== undefined && THREAD_CHANNEL_TYPES.has(type);
  const threads = includeThreads && !isThread ? visibleThreadsOf(context, channelId) : [];
  const result = await context.repos.archiveStats.activity({
    window: period.window,
    previousWindow: period.previous,
    scope: { channelIds: [channelId, ...threads] },
    timeZone: period.timeZone,
    sections: {
      summary: {},
      trend: { granularity: period.granularity },
      heatmap: {},
      channels: { fold: false, limit: options.topN },
      authors: { limit: options.topN },
      reactions: { limit: 1 },
      retention: {},
      topMessages: { limit: TOP_MESSAGES },
    },
  });
  if (!result.ok) return failed(result.error);
  const report = result.value;
  const { summary } = report;
  if (summary.messages === 0) return { kind: 'notice', key: `${K}.no_data` };
  const previous = summary.previousMessages;
  const name = channelName(guild, records, channelId) ?? t(`${K}.unknown_channel`);
  const showBreakdown =
    threads.length > 0 && report.channels.rows.some((row) => row.channelId !== channelId);
  const breakdown = showBreakdown
    ? channelColumn(
        context,
        `${K}.breakdown_title`,
        report.channels,
        (row) =>
          row.channelId === channelId
            ? { name, tag: t(`${K}.this_channel_tag`), value: row.messages }
            : channelRow(context, records, row),
        'rest_threads',
      )
    : weekdayAverages(t, period, report.heatmap);
  const heatmap = heatmapOf(t, period, report.heatmap);
  const image = renderChannelDashboard({
    hero: heroOf(t, summary.messages, previous, [
      dailyAverage(t, summary.messages, period),
      { label: t(`${K}.active_members`), value: formatCount(summary.activeMembers) },
    ]),
    tileRows: [retentionTiles(t, report.retention), [busiestTile(t, period, report.trend.current)]],
    trend: trendOf(t, period, report.trend.current, report.trend.previous),
    interactions: await serverInteractions(context, summary, report.reactions),
    content: contentSection(t, summary),
    members: memberColumn(context, `${K}.members_title`, report.authors),
    breakdown,
    ...(heatmap === undefined ? {} : { heatmap }),
  });
  const hot = topMessagesText(context, report.topMessages);
  return dashboardReply({
    title: t(`${K}.channel.title`, {
      channel: name,
      threads: threads.length > 0 ? t(`${K}.channel.with_threads`) : '',
      range: rangeLabel(t, period.range),
    }),
    image,
    ...(hot === undefined ? {} : { description: hot }),
  });
};
