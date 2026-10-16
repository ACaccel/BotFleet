/**
 * `/traffic me` and `/traffic user`: one member's activity, counted only in the
 * channels the INVOKER may see. A member with no visible activity, including
 * someone who is not in the guild, gets the same neutral no-data answer, so the
 * reply reveals neither restricted channels nor membership.
 */
import { dailyAverage, heroOf, tCount, trendOf } from './activity-common';
import { busiestTile, heatmapOf } from './activity-sections';
import { formatCount, formatPercent, renderPersonDashboard } from './dashboard';
import { rangeLabel } from './labels';
import { cachedBotIds, channelRecordsOf } from './names';
import { personSections, type PersonData } from './person-sections';
import { channelColumn, channelRow } from './rankings';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';

const K = 'replies:traffic';

/** Whose activity is counted, and the name the reply shows. */
export interface PersonSubject {
  readonly id: string;
  readonly displayName: string;
}

export const buildPersonReport = async (
  context: TrafficContext,
  subject: PersonSubject,
): Promise<TrafficOutcome> => {
  const { t, period, options, repos } = context;
  const scope = { channelIds: [...context.visible] };
  const authorId = subject.id;
  const [activity, given, apps] = await Promise.all([
    repos.archiveStats.activity({
      window: period.window,
      previousWindow: period.previous,
      scope,
      timeZone: period.timeZone,
      sections: {
        summary: { authorId },
        trend: { granularity: period.granularity, authorId },
        heatmap: { authorId },
        channels: { authorId, limit: options.topN },
        authors: { limit: 1, rankOf: authorId },
        reactions: { authorId, limit: 1 },
        activeDays: { userId: authorId },
        partners: {
          userId: authorId,
          limit: options.topN,
          excludeUserIds: cachedBotIds(context.guild),
        },
      },
    }),
    repos.archiveStats.reactionsGiven(period.window, authorId, scope),
    repos.archiveStats.appUsage(period.window, scope, { userId: authorId, limit: 1 }),
  ]);
  if (!activity.ok) return failed(activity.error);
  if (!given.ok) return failed(given.error);
  if (!apps.ok) return failed(apps.error);
  const report = activity.value;
  const { summary, authors } = report;
  if (summary.messages === 0) return { kind: 'notice', key: `${K}.person_no_data` };
  const data: PersonData = {
    summary,
    reactions: report.reactions,
    partners: report.partners,
    given: given.value,
    commandUses: apps.value.uses,
  };
  const previous = summary.previousMessages;
  const rank = authors.subject?.rank ?? null;
  const records = channelRecordsOf(context.records);
  const sections = await personSections(context, data);
  const heatmap = heatmapOf(t, period, report.heatmap, `${K}.heatmap.title_person`);
  const images = renderPersonDashboard({
    hero: heroOf(t, summary.messages, previous, [
      dailyAverage(t, summary.messages, period),
      {
        label: t(`${K}.rank`),
        value: rank === null ? '—' : formatCount(rank),
        unit: `/ ${formatCount(authors.distinct)}`,
      },
      { label: t(`${K}.visible_share`), value: formatPercent(summary.messages, authors.total, 1) },
    ]),
    tileRows: [
      [
        { label: t(`${K}.active_channels`), value: formatCount(summary.activeChannels) },
        busiestTile(t, period, report.trend.current),
        {
          label: t(`${K}.active_days`),
          value: formatCount(report.activeDays.activeDays),
          unit: tCount(t, `${K}.active_days_unit`, period.days),
          sub: tCount(t, `${K}.longest_streak`, report.activeDays.longestStreak),
        },
      ],
      sections.reactionTiles,
    ],
    trend: trendOf(t, period, report.trend.current, report.trend.previous),
    interactions: sections.interactions,
    content: sections.content,
    partners: sections.partners,
    partnerLegend: [t(`${K}.partners_reply`), t(`${K}.partners_mention`)],
    // A member's channel distribution lists where they post, not the forum layout.
    channels: channelColumn(context, `${K}.person_channels_title`, report.channels, (row) =>
      channelRow(context, records, row, { forumTag: false }),
    ),
    ...(heatmap === undefined ? {} : { heatmap }),
  });
  return dashboardReply({
    title: t(`${K}.person.title`, {
      user: subject.displayName,
      range: rangeLabel(t, period.range),
    }),
    image: images.summary,
    details: images.details,
  });
};
