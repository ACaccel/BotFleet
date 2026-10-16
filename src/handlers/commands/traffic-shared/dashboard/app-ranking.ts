/**
 * The app ranking of `/traffic apps`: one two-line row per application
 * with its icon (or a coloured initial), total, distinct members, a
 * stacked bar per interaction type, and the per-type breakdown.
 */
import { stripEmoji } from '../canvas-primitives';
import { drawImageFit, isDrawable } from './image';
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { hline, segmentTotal, stackedBar, swatchLegend } from './shapes';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { APP_RANK_LIMIT, COLOR, avatarColorFor, formatCount } from './theme';
import type { AppRanking, AppRow } from './types';

const APP_ROW_HEIGHT = 46;
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

/** Section title with the type legend, then up to `APP_RANK_LIMIT` app rows. */
export const appRanking = (measure: Ctx, ranking: AppRanking, col: Column): Block[] => {
  const apps = ranking.rows.slice(0, APP_RANK_LIMIT);
  const legend = swatchLegend(ranking.legend);
  return [
    sectionTitle(measure, col, ranking.title, { legend, legendSize: 12 }),
    {
      height: 4 + apps.length * APP_ROW_HEIGHT,
      draw: (ctx, y) => drawAppRows(ctx, col, y + 4, apps),
    },
  ];
};
