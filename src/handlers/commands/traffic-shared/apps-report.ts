/**
 * `/traffic apps`: command and component use per application, from interaction
 * records (bot replies that carry `interactionMetadata`) in the visible
 * channels. Ordinary member messages never count here, and the member ranking
 * never lists a bot. With `app`, the reply drills into one application.
 */
import type { Guild } from 'discord.js';

import type { RemoteImageLoader } from '../../../infra/graphics/image-loader';
import type { AppUsageStats } from '../../../persistence/repositories/archive-stats.types';

import { heroOf, tCount } from './activity-common';
import { heatmapOf } from './activity-sections';
import { appBreakdown, appTypeLegend, appTypeRows, usageTrend } from './apps-sections';
import {
  formatCount,
  formatPercent,
  renderAppSingleDashboard,
  renderAppsDashboard,
  type AppRow,
  type RankingColumn,
} from './dashboard';
import { rangeLabel } from './labels';
import { memberName, resolveUserNames } from './names';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';

const K = 'replies:traffic';

const appIcon = async (
  guild: Guild,
  images: RemoteImageLoader,
  applicationId: string,
): Promise<AppRow['icon']> => {
  const url = guild.members.cache
    .get(applicationId)
    ?.user.displayAvatarURL({ extension: 'png', size: 64 });
  return url === undefined ? null : images.load(url);
};

const membersColumn = async (
  context: TrafficContext,
  usage: AppUsageStats,
): Promise<RankingColumn> => {
  const unknown = context.t(`${K}.unknown_member`);
  const names = await resolveUserNames(
    context.guild,
    usage.topUsers.map((row) => row.userId),
    unknown,
  );
  return {
    title: context.t(`${K}.apps.members_title`, { n: usage.topUsers.length }),
    rows: usage.topUsers.map((row) => ({
      name: names.get(row.userId) ?? unknown,
      value: row.uses,
    })),
  };
};

export const buildAppsReport = async (
  context: TrafficContext,
  applicationId: string | undefined,
): Promise<TrafficOutcome> => {
  const { t, period, options, guild, repos } = context;
  const scope = { channelIds: [...context.visible] };
  const trend = { granularity: period.granularity, timeZone: period.timeZone };
  const app = applicationId === undefined ? {} : { applicationId };
  const heatmap = applicationId === undefined ? {} : { heatmap: { timeZone: period.timeZone } };
  const [current, previous, all] = await Promise.all([
    repos.archiveStats.appUsage(period.window, scope, {
      ...app,
      limit: options.topN,
      trend,
      ...heatmap,
    }),
    repos.archiveStats.appUsage(period.previous, scope, { ...app, limit: 1, trend }),
    applicationId === undefined
      ? undefined
      : repos.archiveStats.appUsage(period.window, scope, { limit: 1 }),
  ]);
  if (!current.ok) return failed(current.error);
  if (!previous.ok) return failed(previous.error);
  if (all !== undefined && !all.ok) return failed(all.error);
  const usage = current.value;
  if (usage.uses === 0) return { kind: 'notice', key: `${K}.apps_no_data` };
  const before = previous.value;
  const range = rangeLabel(t, period.range);
  const users = { label: t(`${K}.apps.members`), value: formatCount(usage.users) };
  const hero = (metrics: { label: string; value: string }[]) =>
    heroOf(t, usage.uses, before.uses, metrics, t(`${K}.apps.uses`));
  const members = await membersColumn(context, usage);

  if (applicationId !== undefined && all?.ok === true) {
    const row = usage.apps[0];
    const share = formatPercent(usage.uses, all.value.uses, 1);
    const appHeatmap = heatmapOf(
      t,
      period,
      usage.heatmap,
      `${K}.heatmap.title`,
      `${K}.heatmap.more_uses`,
    );
    const name = memberName(guild, applicationId, row ?? {}, t(`${K}.unknown_member`));
    const image = renderAppSingleDashboard({
      hero: hero([users, { label: t(`${K}.apps.share`), value: share }]),
      types: { title: t(`${K}.apps.types_title`), rows: appTypeRows(t, row) },
      trend: usageTrend(t, period, usage, before),
      members,
      ...(appHeatmap === undefined ? {} : { heatmap: appHeatmap }),
    });
    return dashboardReply({ title: t(`${K}.app.title`, { app: name, range }), image });
  }

  const unknown = t(`${K}.unknown_member`);
  const rows = await Promise.all(
    usage.apps.slice(0, options.topN).map(async (row) => ({
      name: memberName(guild, row.applicationId, row, unknown),
      icon: await appIcon(guild, context.images, row.applicationId),
      segments: [row.commands, row.components, row.modals],
      users: tCount(t, `${K}.apps.users`, row.users),
      breakdown: appBreakdown(t, row),
    })),
  );
  const image = renderAppsDashboard({
    hero: hero([users, { label: t(`${K}.apps.apps`), value: formatCount(usage.apps.length) }]),
    ranking: { title: t(`${K}.apps.ranking_title`), legend: appTypeLegend(t), rows },
    trend: usageTrend(t, period, usage, before),
    members,
  });
  return dashboardReply({ title: t(`${K}.apps.title`, { range }), image });
};
