/**
 * `/traffic overview`: the server's member activity in the visible channels,
 * from one archive scan. Text-channel threads fold into their channel in the
 * channel ranking; forum posts stand alone.
 */
import { dailyAverage, heroOf, tCount, trendOf } from './activity-common';
import { busiestTile, heatmapOf, retentionTiles } from './activity-sections';
import { formatCount, formatPercent, renderOverviewDashboard, type StatTile } from './dashboard';
import { rangeLabel } from './labels';
import { channelRecordsOf, memberName } from './names';
import { channelColumn, channelRow, memberColumn, topMessagesText } from './rankings';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';
import { contentSection, serverInteractions } from './server-sections';

const K = 'replies:traffic';
const TOP_MESSAGES = 3;

export const buildOverviewReport = async (context: TrafficContext): Promise<TrafficOutcome> => {
  const { t, period, options, guild } = context;
  const result = await context.repos.archiveStats.activity({
    window: period.window,
    previousWindow: period.previous,
    scope: { channelIds: [...context.visible] },
    timeZone: period.timeZone,
    sections: {
      summary: {},
      trend: { granularity: period.granularity },
      heatmap: {},
      channels: { limit: options.topN },
      authors: { limit: options.topN },
      reactions: { limit: 1 },
      retention: {},
      topMessages: { limit: TOP_MESSAGES },
    },
  });
  if (!result.ok) return failed(result.error);
  const report = result.value;
  const { summary, authors } = report;
  if (summary.messages === 0) return { kind: 'notice', key: `${K}.no_data` };
  const previous = summary.previousMessages;
  const records = channelRecordsOf(context.records);

  const top = authors.rows[0];
  const topShare: StatTile = {
    label: t(`${K}.top_share`),
    flex: 1.1,
    value: top === undefined ? '—' : formatPercent(top.messages, authors.total, 1),
    ...(top === undefined
      ? {}
      : {
          sub: tCount(t, `${K}.top_share_sub`, top.messages, {
            name: memberName(guild, top.userId, top, t(`${K}.unknown_member`)),
          }),
        }),
  };
  const heatmap = heatmapOf(t, period, report.heatmap);
  const image = renderOverviewDashboard({
    hero: heroOf(t, summary.messages, previous, [
      dailyAverage(t, summary.messages, period),
      { label: t(`${K}.active_members`), value: formatCount(summary.activeMembers) },
      { label: t(`${K}.active_channels`), value: formatCount(summary.activeChannels) },
    ]),
    tileRows: [
      retentionTiles(t, report.retention),
      [topShare, busiestTile(t, period, report.trend.current)],
    ],
    trend: trendOf(t, period, report.trend.current, report.trend.previous),
    interactions: await serverInteractions(context, summary, report.reactions),
    content: contentSection(t, summary),
    members: memberColumn(context, `${K}.members_title`, authors),
    channels: channelColumn(context, `${K}.channels_title`, report.channels, (row) =>
      channelRow(context, records, row),
    ),
    ...(heatmap === undefined ? {} : { heatmap }),
  });
  const hot = topMessagesText(context, report.topMessages);
  return dashboardReply({
    title: t(`${K}.overview.title`, { guild: guild.name, range: rangeLabel(t, period.range) }),
    image,
    ...(hot === undefined ? {} : { description: hot }),
  });
};
