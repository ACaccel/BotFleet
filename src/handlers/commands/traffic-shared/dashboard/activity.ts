/**
 * Message-activity dashboards: server overview, single channel, and a
 * person (`/traffic me` and `/traffic user` share this layout), as three
 * landscape columns. Left: the hero, its metrics and the tile rows above
 * the trend, which grows to fill the column. Middle: interactions beside
 * content types above the first ranking. Right: the second ranking above
 * the weekday x hour heatmap. The 24h range has no heatmap, so the middle
 * and right columns merge into one wide column with the rankings paired.
 */
import { COLUMN_SPACING, renderColumns, type ColumnSpec } from './columns';
import { heatmapBlocks } from './heatmap';
import type { Column, Ctx, Section } from './layout';
import { detailPair } from './detail-pair';
import { rankingList, rankingPair, type PairOptions } from './ranking-lists';
import { swatchLegend, type LegendItem } from './shapes';
import { kpiBlocks } from './tiles';
import { TREND_CHART_HEIGHT, trendBlocks } from './trend';
import type {
  ActivityDashboardBase,
  ChannelDashboard,
  OverviewDashboard,
  PersonDashboard,
} from './types';
import type { AnyRankRow, RankingColumn } from './types-common';

interface ActivityLayout {
  readonly left: number;
  readonly middle: number;
  readonly right: number;
}

/** Column widths: the person's tile rows hold three tiles, so its left column is wider. */
const SERVER_LAYOUT: ActivityLayout = { left: 256, middle: 336, right: 268 };
const PERSON_LAYOUT: ActivityLayout = { left: 300, middle: 330, right: 268 };

interface Rankings {
  readonly first: RankingColumn<AnyRankRow>;
  readonly second: RankingColumn<AnyRankRow>;
  /** How the two rankings share the merged column of the 24h layout. */
  readonly split: PairOptions['split'];
  /** Legend for the first ranking's split bars. */
  readonly legend?: readonly LegendItem[];
}

const summaryColumn = (data: ActivityDashboardBase, width: number): ColumnSpec => ({
  width,
  grows: true,
  sections: (col, measure, extra) => [
    kpiBlocks(data.hero, data.tileRows, col, 'stacked'),
    trendBlocks(measure, data.trend, col, TREND_CHART_HEIGHT + extra),
  ],
});

const legendOption = (rankings: Rankings) =>
  rankings.legend === undefined ? {} : { legend: rankings.legend };

const activityColumns = (
  data: ActivityDashboardBase,
  rankings: Rankings,
  layout: ActivityLayout,
): ColumnSpec[] => {
  const { heatmap } = data;
  const details = (col: Column): Section => detailPair(data.interactions, data.content, col);
  if (heatmap === undefined) {
    return [
      summaryColumn(data, layout.left),
      {
        width: layout.middle + COLUMN_SPACING + layout.right,
        sections: (col) => [
          details(col),
          rankingPair(rankings.first, rankings.second, col, {
            split: rankings.split,
            ...legendOption(rankings),
          }),
        ],
      },
    ];
  }
  return [
    summaryColumn(data, layout.left),
    {
      width: layout.middle,
      sections: (col) => [details(col), rankingList(rankings.first, col, legendOption(rankings))],
    },
    {
      width: layout.right,
      sections: (col: Column, measure: Ctx) => [
        rankingList(rankings.second, col),
        heatmapBlocks(measure, heatmap, col),
      ],
    },
  ];
};

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderOverviewDashboard = (data: OverviewDashboard): Buffer =>
  renderColumns(
    activityColumns(
      data,
      { first: data.members, second: data.channels, split: 'narrow-wide' },
      SERVER_LAYOUT,
    ),
  );

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderChannelDashboard = (data: ChannelDashboard): Buffer =>
  renderColumns(
    activityColumns(
      data,
      { first: data.members, second: data.breakdown, split: 'even' },
      SERVER_LAYOUT,
    ),
  );

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderPersonDashboard = (data: PersonDashboard): Buffer =>
  renderColumns(
    activityColumns(
      data,
      {
        first: data.partners,
        second: data.channels,
        split: 'narrow-wide',
        legend: swatchLegend(data.partnerLegend),
      },
      PERSON_LAYOUT,
    ),
  );
