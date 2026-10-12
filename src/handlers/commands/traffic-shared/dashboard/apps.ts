/**
 * Application-usage dashboards: every app ranked with a per-type stacked
 * bar, and the single-app drill-down with its interaction-type split and
 * heatmap. Both show the most active members as a top 10.
 */
import { stripEmoji } from '../canvas-primitives';
import { drawBars } from './bars';
import { heatmapBlocks } from './heatmap';
import { drawImageFit, isDrawable } from './image';
import { renderColumns } from './columns';
import { TITLE_HEIGHT, drawTitle, sectionTitle, type Block, type Column, type Ctx } from './layout';
import { foldedRanking, rankingList } from './ranking-lists';
import { hline, segmentTotal, stackedBar, swatchLegend } from './shapes';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { COLOR, RANK_ROW_LIMIT, avatarColorFor, formatCount, segmentColor } from './theme';
import { heroTile } from './hero';
import { trendBlocks } from './trend';
import type { AppRanking, AppRow, AppSingleDashboard, AppsDashboard } from './types';
import type { BarRow, TitledRows } from './types-common';

const APP_ROW_HEIGHT = 46;
const TYPE_ROW_HEIGHT = 24;
const APP_TREND_HEIGHT = 150;
const BAR_LEFT = 40;

const appTotal = (app: AppRow): number => segmentTotal(app.segments);

const drawAvatar = (ctx: Ctx, app: AppRow, cx: number, cy: number): void => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  if (isDrawable(app.icon)) {
    ctx.clip();
    drawImageFit(ctx, app.icon, cx - 10, cy - 10, 20, 20);
  } else {
    ctx.fillStyle = avatarColorFor(app.name);
    ctx.fill();
    const initial = Array.from(stripEmoji(app.name))[0] ?? '?';
    drawText(ctx, initial, cx, cy, { size: 11, color: COLOR.white, bold: true, align: 'center' });
  }
  ctx.restore();
};

const drawAppRows = (ctx: Ctx, col: Column, y: number, apps: readonly AppRow[]): void => {
  const { x, w } = col;
  const right = x + w;
  const max = Math.max(1, ...apps.map(appTotal));
  const breakdownW = Math.max(120, ...apps.map((a) => textWidth(ctx, a.breakdown, 12)));
  const barMax = Math.max(40, w - BAR_LEFT - breakdownW - 12);
  apps.forEach((app, i) => {
    const top = y + i * APP_ROW_HEIGHT;
    const l1 = top + 13;
    const l2 = top + 31;
    if (i > 0) hline(ctx, x, right, top, COLOR.grid);
    drawText(ctx, String(i + 1), x, l1 + 1, { size: 13, color: COLOR.muted });
    drawAvatar(ctx, app, x + 24, l1 + 1);
    const users = fitText(ctx, app.users, 90, 13);
    drawText(ctx, users, right, l1, { size: 13, color: COLOR.muted, align: 'right' });
    const totalRight = right - Math.max(52, textWidth(ctx, users, 13) + 12);
    const total = formatCount(appTotal(app));
    const totalStyle = { size: 15, color: COLOR.ink, bold: true, align: 'right' } as const;
    drawText(ctx, total, totalRight, l1, totalStyle);
    const nameMax = totalRight - textWidth(ctx, total, 15) - 12 - (x + BAR_LEFT);
    drawFitted(ctx, app.name, x + BAR_LEFT, l1, nameMax, { size: 14, color: COLOR.ink });
    stackedBar(ctx, x + BAR_LEFT, l2 - 4, (appTotal(app) / max) * barMax, 8, app.segments);
    const breakdown = fitText(ctx, app.breakdown, w - BAR_LEFT - barMax - 12, 12);
    drawText(ctx, breakdown, right, l2, { size: 12, color: COLOR.muted, align: 'right' });
  });
};

const appRanking = (measure: Ctx, ranking: AppRanking, col: Column): Block[] => {
  const apps = ranking.rows.slice(0, RANK_ROW_LIMIT);
  const legend = swatchLegend(ranking.legend);
  return [
    sectionTitle(measure, col, ranking.title, { legend, legendSize: 12 }),
    {
      height: 4 + apps.length * APP_ROW_HEIGHT,
      draw: (ctx, y) => drawAppRows(ctx, col, y + 4, apps),
    },
  ];
};

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

/** Both apps dashboards use two wide columns. */
const SUMMARY_WIDTH = 420;
const RANKING_WIDTH = 440;

/**
 * Two columns: the hero, the trend (which grows to fill the column) and
 * the top members folded into two halves, beside every app with its
 * per-type split bar.
 */
export const renderAppsDashboard = (data: AppsDashboard): Buffer =>
  renderColumns([
    {
      width: SUMMARY_WIDTH,
      grows: true,
      sections: (col, measure, extra) => [
        heroTile(data.hero, col),
        trendBlocks(measure, data.trend, col, APP_TREND_HEIGHT + extra),
        foldedRanking(data.members, col),
      ],
    },
    {
      width: RANKING_WIDTH,
      sections: (col, measure) => [appRanking(measure, data.ranking, col)],
    },
  ]);

/**
 * Two columns: the hero, the interaction types and the trend (which grows
 * to fill the column) beside the top members and the heatmap. Without a
 * heatmap (24h) the interaction types move above the members to keep the
 * columns balanced.
 * @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels.
 */
export const renderAppSingleDashboard = (data: AppSingleDashboard): Buffer => {
  const { heatmap } = data;
  return renderColumns([
    {
      width: SUMMARY_WIDTH,
      grows: true,
      sections: (col, measure, extra) => [
        heroTile(data.hero, col),
        heatmap === undefined ? undefined : typeBars(data.types, col),
        trendBlocks(measure, data.trend, col, APP_TREND_HEIGHT + extra),
      ],
    },
    {
      width: SUMMARY_WIDTH,
      sections: (col, measure) => [
        heatmap === undefined ? typeBars(data.types, col) : undefined,
        rankingList(data.members, col),
        heatmap === undefined ? undefined : heatmapBlocks(measure, heatmap, col),
      ],
    },
  ]);
};
