/**
 * Application-usage dashboards: every app ranked with a per-type stacked
 * bar, and the single-app drill-down with its interaction-type split and
 * heatmap. Both show the most active members as a top 5.
 */
import { appRanking } from './app-ranking';
import { drawBars } from './bars';
import { EMBED_IMAGE_ASPECT, renderColumns } from './columns';
import { heatmapBlocks } from './heatmap';
import { TITLE_HEIGHT, drawTitle, type Block, type Column } from './layout';
import { rankingList } from './ranking-lists';
import { segmentColor } from './theme';
import { kpiBlocks } from './tiles';
import { TREND_CHART_HEIGHT, trendBlocks } from './trend';
import type { AppSingleDashboard, AppsDashboard } from './types';
import type { BarRow, TitledRows } from './types-common';

const TYPE_ROW_HEIGHT = 24;

const typeBars = (types: TitledRows<BarRow>, col: Column): Block => ({
  height: TITLE_HEIGHT + types.rows.length * TYPE_ROW_HEIGHT,
  draw: (ctx, y) => {
    drawTitle(ctx, types.title, col.x, y, col.w);
    drawBars(ctx, col.x, y + TITLE_HEIGHT, col.w, types.rows, {
      rowHeight: TYPE_ROW_HEIGHT,
      colorFor: segmentColor,
    });
  },
});

/** Column widths: summary and app ranking; the single-app view has summary and members. */
const APPS_LAYOUT = { summary: 260, ranking: 300 } as const;
const APP_SINGLE_LAYOUT = { summary: 290, members: 270 } as const;
const options = { maxAspect: EMBED_IMAGE_ASPECT } as const;

/**
 * Two columns near 4:3: the hero with its metrics above the trend (which
 * grows to fill the column), beside the apps with their per-type split
 * bars and the top members.
 */
export const renderAppsDashboard = (data: AppsDashboard): Buffer =>
  renderColumns(
    [
      {
        width: APPS_LAYOUT.summary,
        grows: true,
        sections: (col, measure, extra) => [
          kpiBlocks(data.hero, [], col, 'stacked'),
          trendBlocks(measure, data.trend, col, TREND_CHART_HEIGHT + extra),
        ],
      },
      {
        width: APPS_LAYOUT.ranking,
        sections: (col, measure) => [
          appRanking(measure, data.ranking, col),
          rankingList(data.members, col),
        ],
      },
    ],
    options,
  );

/**
 * Two columns near 4:3: the hero with its metrics, the interaction types
 * and the trend (which grows to fill the column), beside the top members
 * and the heatmap. Without a heatmap (24h) the interaction types move
 * above the members.
 * @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels.
 */
export const renderAppSingleDashboard = (data: AppSingleDashboard): Buffer => {
  const { heatmap } = data;
  return renderColumns(
    [
      {
        width: APP_SINGLE_LAYOUT.summary,
        grows: true,
        sections: (col, measure, extra) => [
          kpiBlocks(data.hero, [], col, 'stacked'),
          heatmap === undefined ? undefined : typeBars(data.types, col),
          trendBlocks(measure, data.trend, col, TREND_CHART_HEIGHT + extra),
        ],
      },
      {
        width: APP_SINGLE_LAYOUT.members,
        sections: (col, measure) => [
          heatmap === undefined ? typeBars(data.types, col) : undefined,
          rankingList(data.members, col),
          heatmap === undefined ? undefined : heatmapBlocks(measure, heatmap, col),
        ],
      },
    ],
    options,
  );
};
