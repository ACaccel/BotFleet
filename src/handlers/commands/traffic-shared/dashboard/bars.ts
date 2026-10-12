/**
 * Horizontal bar lists: ranked rows (optional rank numbers, forum tag
 * chip, stacked segments) and plain labelled bars. Labels are capped to a
 * share of the column and truncated with an ellipsis so long names never
 * squeeze the bars away.
 */
import { roundRect } from '../canvas-primitives';
import type { Ctx } from './layout';
import { hbar, segmentTotal, stackedBar } from './shapes';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { COLOR, formatCount } from './theme';
import type { AnyRankRow, BarRow } from './types-common';

export const ROW_HEIGHT = 22;
const SIZE = 13;
const BAR_HEIGHT = 12;
const TAG_SIZE = 10;
const TAG_MAX_WIDTH = 72;
const LABEL_SHARE = 0.5;

/** A row's bar total; a negative count draws as an empty bar, like a segment. */
const rowTotal = (row: AnyRankRow): number =>
  row.segments === undefined ? Math.max(0, row.value) : segmentTotal(row.segments);

export interface RankBarOptions {
  readonly ranked?: boolean;
  readonly rankStart?: number;
  /** Shared bar scale, so split columns stay comparable. */
  readonly max?: number;
}

const tagWidth = (ctx: Ctx, tag: string): number =>
  Math.min(textWidth(ctx, tag, TAG_SIZE) + 8, TAG_MAX_WIDTH);

const drawTag = (ctx: Ctx, tag: string, x: number, cy: number): void => {
  const w = tagWidth(ctx, tag);
  roundRect(ctx, x, cy - 7, w, 14, 3);
  ctx.fillStyle = COLOR.tagFill;
  ctx.fill();
  drawFitted(ctx, tag, x + 4, cy + 0.5, w - 8, { size: TAG_SIZE, color: COLOR.muted });
};

export const drawRankBars = (
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  rows: readonly AnyRankRow[],
  options: RankBarOptions = {},
): void => {
  if (rows.length === 0) return;
  const ranked = options.ranked ?? true;
  const rankStart = options.rankStart ?? 1;
  const rankW = ranked
    ? textWidth(ctx, String(Math.max(10, rankStart + rows.length - 1)), SIZE) + 10
    : 0;
  const natural = (r: AnyRankRow): number =>
    textWidth(ctx, r.name, SIZE) + (r.tag === undefined ? 0 : 6 + tagWidth(ctx, r.tag));
  const labelW = Math.min(Math.max(...rows.map(natural)) + 10, (w - rankW) * LABEL_SHARE);
  const values = rows.map((r) => formatCount(rowTotal(r)));
  const valW = Math.max(...values.map((t) => textWidth(ctx, t, SIZE))) + 8;
  const barX = x + rankW + labelW;
  const barMax = Math.max(0, w - rankW - labelW - valW);
  const max = Math.max(1, options.max ?? Math.max(...rows.map(rowTotal)));
  rows.forEach((row, i) => {
    const cy = y + i * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (ranked) drawText(ctx, String(rankStart + i), x, cy, { size: SIZE, color: COLOR.muted });
    const tagReserve = row.tag === undefined ? 0 : 6 + tagWidth(ctx, row.tag);
    const name = fitText(ctx, row.name, labelW - 10 - tagReserve, SIZE);
    drawText(ctx, name, x + rankW, cy, { size: SIZE, color: COLOR.ink });
    if (row.tag !== undefined) {
      drawTag(ctx, row.tag, x + rankW + textWidth(ctx, name, SIZE) + 6, cy);
    }
    const len = (rowTotal(row) / max) * barMax;
    if (row.segments === undefined)
      hbar(ctx, barX, cy - BAR_HEIGHT / 2, len, BAR_HEIGHT, COLOR.current);
    else stackedBar(ctx, barX, cy - BAR_HEIGHT / 2, len, BAR_HEIGHT, row.segments);
    const vx = barX + Math.max(len, 1.5) + 6;
    drawText(ctx, values[i] ?? '', vx, cy, { size: SIZE, color: COLOR.body });
  });
};

export interface BarOptions {
  readonly rowHeight?: number;
  readonly colorFor?: (index: number) => string;
  /** Largest share of the width the labels may take (default 0.5). */
  readonly labelShare?: number;
}

/** Labelled bars without rank numbers (content composition, interaction types). */
export const drawBars = (
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  rows: readonly BarRow[],
  options: BarOptions = {},
): void => {
  if (rows.length === 0) return;
  const rowH = options.rowHeight ?? ROW_HEIGHT;
  const labelW = Math.min(
    Math.max(...rows.map((r) => textWidth(ctx, r.label, SIZE))) + 12,
    w * (options.labelShare ?? LABEL_SHARE),
  );
  const values = rows.map((r) => r.valueText ?? formatCount(r.value));
  const valW = Math.max(...values.map((t) => textWidth(ctx, t, SIZE))) + 8;
  const barX = x + labelW;
  const barMax = Math.max(0, w - labelW - valW);
  const max = Math.max(1, ...rows.map((r) => r.value));
  rows.forEach((row, i) => {
    const cy = y + i * rowH + rowH / 2;
    drawFitted(ctx, row.label, x, cy, labelW - 12, { size: SIZE, color: COLOR.ink });
    const len = (Math.max(0, row.value) / max) * barMax;
    hbar(ctx, barX, cy - BAR_HEIGHT / 2, len, BAR_HEIGHT, options.colorFor?.(i) ?? COLOR.current);
    const vx = barX + Math.max(len, 1.5) + 6;
    drawText(ctx, values[i] ?? '', vx, cy, { size: SIZE, color: COLOR.body });
  });
};
