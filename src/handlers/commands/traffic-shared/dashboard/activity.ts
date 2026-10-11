/**
 * Message-activity dashboards: server overview, single channel, and a
 * person (`/traffic me` and `/traffic user` share this layout). Top to
 * bottom: KPI tiles, period trend, interactions beside content types,
 * paired rankings, and the weekday x hour heatmap (omitted for 24h).
 */
import { heatmapBlocks } from './heatmap';
import { renderBlocks, withGaps, type Section } from './layout';
import { detailPair, rankingPair } from './sections';
import { swatchLegend } from './shapes';
import { kpiBlocks } from './tiles';
import { trendBlocks } from './trend';
import type {
  ActivityDashboardBase,
  ChannelDashboard,
  OverviewDashboard,
  PersonDashboard,
} from './types';

const activitySections = (data: ActivityDashboardBase, rankings: Section): Section[] => [
  kpiBlocks(data.hero, data.tileRows),
  trendBlocks(data.trend),
  detailPair(data.interactions, data.content),
  rankings,
  data.heatmap === undefined ? undefined : heatmapBlocks(data.heatmap),
];

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderOverviewDashboard = (data: OverviewDashboard): Buffer =>
  renderBlocks(() =>
    withGaps(
      activitySections(data, rankingPair(data.members, data.channels, { split: 'narrow-wide' })),
    ),
  );

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderChannelDashboard = (data: ChannelDashboard): Buffer =>
  renderBlocks(() =>
    withGaps(activitySections(data, rankingPair(data.members, data.breakdown, { split: 'even' }))),
  );

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderPersonDashboard = (data: PersonDashboard): Buffer =>
  renderBlocks(() =>
    withGaps(
      activitySections(
        data,
        rankingPair(data.partners, data.channels, {
          split: 'narrow-wide',
          legend: swatchLegend(data.partnerLegend),
        }),
      ),
    ),
  );
