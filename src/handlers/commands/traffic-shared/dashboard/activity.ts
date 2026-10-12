/**
 * Message-activity dashboards: server overview, single channel, and a
 * person (`/traffic me` and `/traffic user` share this layout), as two
 * columns laid out near Discord's 4:3 embed image box. Left: the hero, its
 * metrics and the tile rows above the trend, which grows to fill the
 * column. Right: interactions beside content types, the two top-5
 * rankings side by side, and the weekday x hour heatmap. The 24h range has
 * no heatmap, so the right column stacks the two rankings instead.
 */
import { EMBED_IMAGE_ASPECT, renderColumns, type ColumnSpec } from './columns';
import { detailPair } from './detail-pair';
import { heatmapBlocks } from './heatmap';
import type { Section } from './layout';
import { rankingList, rankingPair } from './ranking-lists';
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
  readonly summary: number;
  readonly details: number;
}

/** Column widths; the person's tile rows hold three tiles, so its summary column is wider. */
const SERVER_LAYOUT: ActivityLayout = { summary: 280, details: 420 };
const PERSON_LAYOUT: ActivityLayout = { summary: 300, details: 420 };

interface Rankings {
  readonly first: RankingColumn<AnyRankRow>;
  /** The wider list of a pair: channels or threads, whose names carry tags. */
  readonly second: RankingColumn<AnyRankRow>;
  /** Legend for the first ranking's split bars. */
  readonly legend?: readonly LegendItem[];
}

const activityColumns = (
  data: ActivityDashboardBase,
  rankings: Rankings,
  layout: ActivityLayout,
): ColumnSpec[] => {
  const { heatmap } = data;
  const legend = rankings.legend === undefined ? {} : { legend: rankings.legend };
  return [
    {
      width: layout.summary,
      grows: true,
      sections: (col, measure, extra) => [
        kpiBlocks(data.hero, data.tileRows, col, 'stacked'),
        trendBlocks(measure, data.trend, col, TREND_CHART_HEIGHT + extra),
      ],
    },
    {
      width: layout.details,
      sections: (col, measure): Section[] => [
        detailPair(data.interactions, data.content, col),
        ...(heatmap === undefined
          ? [rankingList(rankings.first, col, legend), rankingList(rankings.second, col)]
          : [
              rankingPair(measure, rankings.first, rankings.second, col, legend),
              heatmapBlocks(measure, heatmap, col),
            ]),
      ],
    },
  ];
};

const render = (data: ActivityDashboardBase, rankings: Rankings, layout: ActivityLayout): Buffer =>
  renderColumns(activityColumns(data, rankings, layout), { maxAspect: EMBED_IMAGE_ASPECT });

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderOverviewDashboard = (data: OverviewDashboard): Buffer =>
  render(data, { first: data.members, second: data.channels }, SERVER_LAYOUT);

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderChannelDashboard = (data: ChannelDashboard): Buffer =>
  render(data, { first: data.members, second: data.breakdown }, SERVER_LAYOUT);

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderPersonDashboard = (data: PersonDashboard): Buffer =>
  render(
    data,
    { first: data.partners, second: data.channels, legend: swatchLegend(data.partnerLegend) },
    PERSON_LAYOUT,
  );
