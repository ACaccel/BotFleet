/**
 * Message-activity dashboards: server overview, single channel, and a
 * person (`/traffic me` and `/traffic user` share this layout). Each is two
 * landscape images of one width, sent as two embeds: split in two, the
 * content is drawn larger than in one image, and laid out at its natural
 * height the pair stays short. Summary: the hero, its metrics and the tile
 * rows beside the trend (which grows to the tiles' height) over the
 * interactions. Details: content types over the weekday x hour heatmap,
 * beside the two top-5 rankings. The 24h range has no heatmap.
 */
import { renderColumns } from './columns';
import { barList, keyValueList } from './detail-lists';
import { heatmapBlocks } from './heatmap';
import { rankingList } from './ranking-lists';
import { swatchLegend, type LegendItem } from './shapes';
import { kpiBlocks } from './tiles';
import { trendBlocks } from './trend';
import type {
  ActivityDashboardBase,
  ChannelDashboard,
  OverviewDashboard,
  PersonDashboard,
} from './types';
import type { AnyRankRow, RankingColumn } from './types-common';

/** Every column of both images; three tiles fit a row. */
const COLUMN_WIDTH = 300;
/** The summary trend's chart height before it grows to the tiles' height. */
const TREND_MIN_HEIGHT = 90;

/** The two images of an activity dashboard, in reply order. */
export interface ActivityDashboardImages {
  readonly summary: Buffer;
  readonly details: Buffer;
}

interface Rankings {
  readonly first: RankingColumn<AnyRankRow>;
  readonly second: RankingColumn<AnyRankRow>;
  /** Legend for the first ranking's split bars. */
  readonly legend?: readonly LegendItem[];
}

const render = (data: ActivityDashboardBase, rankings: Rankings): ActivityDashboardImages => {
  const { heatmap } = data;
  const legend = rankings.legend === undefined ? {} : { legend: rankings.legend };
  return {
    summary: renderColumns([
      {
        width: COLUMN_WIDTH,
        sections: (col) => [kpiBlocks(data.hero, data.tileRows, col, 'stacked')],
      },
      {
        width: COLUMN_WIDTH,
        grows: true,
        sections: (col, measure, extra) => [
          trendBlocks(measure, data.trend, col, TREND_MIN_HEIGHT + extra),
          keyValueList(data.interactions, col),
        ],
      },
    ]),
    details: renderColumns([
      {
        width: COLUMN_WIDTH,
        sections: (col, measure) => [
          barList(data.content, col),
          heatmap === undefined ? undefined : heatmapBlocks(measure, heatmap, col),
        ],
      },
      {
        width: COLUMN_WIDTH,
        sections: (col) => [
          rankingList(rankings.first, col, legend),
          rankingList(rankings.second, col),
        ],
      },
    ]),
  };
};

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderOverviewDashboard = (data: OverviewDashboard): ActivityDashboardImages =>
  render(data, { first: data.members, second: data.channels });

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderChannelDashboard = (data: ChannelDashboard): ActivityDashboardImages =>
  render(data, { first: data.members, second: data.breakdown });

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderPersonDashboard = (data: PersonDashboard): ActivityDashboardImages =>
  render(data, {
    first: data.partners,
    second: data.channels,
    legend: swatchLegend(data.partnerLegend),
  });
