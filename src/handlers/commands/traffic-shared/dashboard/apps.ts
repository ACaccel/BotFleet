/**
 * Application-usage dashboards: every app ranked with a per-type stacked
 * bar, and the single-app drill-down with its interaction-type split and
 * heatmap. Both end with the most active members as a folded top 10.
 */
import { stripEmoji } from '../canvas-primitives';
import { drawBars } from './bars';
import { heatmapBlocks } from './heatmap';
import { drawImageFit, isDrawable } from './image';
import {
  TITLE_HEIGHT,
  drawTitle,
  renderBlocks,
  sectionTitle,
  withGaps,
  type Block,
  type Ctx,
} from './layout';
import { foldedRanking } from './sections';
import { hline, segmentTotal, stackedBar, swatchLegend } from './shapes';
import { drawFitted, drawText, fitText, textWidth } from './text';
import {
  COLOR,
  INNER_WIDTH,
  PAD,
  RANK_ROW_LIMIT,
  avatarColorFor,
  formatCount,
  segmentColor,
} from './theme';
import { heroTile } from './tiles';
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

const drawAppRows = (ctx: Ctx, y: number, apps: readonly AppRow[]): void => {
  const x = PAD;
  const right = x + INNER_WIDTH;
  const max = Math.max(1, ...apps.map(appTotal));
  const breakdownW = Math.max(120, ...apps.map((a) => textWidth(ctx, a.breakdown, 12)));
  const barMax = Math.max(40, INNER_WIDTH - BAR_LEFT - breakdownW - 12);
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
    const breakdown = fitText(ctx, app.breakdown, breakdownW, 12);
    drawText(ctx, breakdown, right, l2, { size: 12, color: COLOR.muted, align: 'right' });
  });
};

const appRanking = (ranking: AppRanking): Block[] => {
  const apps = ranking.rows.slice(0, RANK_ROW_LIMIT);
  return [
    sectionTitle(ranking.title, { legend: swatchLegend(ranking.legend), legendSize: 12 }),
    { height: 4 + apps.length * APP_ROW_HEIGHT, draw: (ctx, y) => drawAppRows(ctx, y + 4, apps) },
  ];
};

const typeBars = (types: TitledRows<BarRow>): Block => ({
  height: TITLE_HEIGHT + types.rows.length * TYPE_ROW_HEIGHT,
  draw: (ctx, y) => {
    drawTitle(ctx, types.title, PAD, y, INNER_WIDTH);
    drawBars(ctx, PAD, y + TITLE_HEIGHT, INNER_WIDTH, types.rows, {
      rowHeight: TYPE_ROW_HEIGHT,
      colorFor: segmentColor,
    });
  },
});

export const renderAppsDashboard = (data: AppsDashboard): Buffer =>
  renderBlocks(() =>
    withGaps([
      heroTile(data.hero),
      appRanking(data.ranking),
      trendBlocks(data.trend, APP_TREND_HEIGHT),
      foldedRanking(data.members),
    ]),
  );

/** @throws {RangeError} When `data.heatmap` is not a 7 x 24 grid with seven weekday labels. */
export const renderAppSingleDashboard = (data: AppSingleDashboard): Buffer =>
  renderBlocks(() =>
    withGaps([
      heroTile(data.hero),
      typeBars(data.types),
      trendBlocks(data.trend, APP_TREND_HEIGHT),
      foldedRanking(data.members),
      data.heatmap === undefined ? undefined : heatmapBlocks(data.heatmap),
    ]),
  );
