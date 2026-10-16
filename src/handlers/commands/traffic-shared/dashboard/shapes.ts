/**
 * Shape primitives for the dashboards: bars, hairlines, legend keys,
 * and period-delta triangles.
 */
import { roundRect } from '../canvas-primitives';
import type { Ctx } from './layout';
import { drawText, textWidth } from './text';
import { COLOR, segmentColor } from './theme';

/** Sum of the positive segments; negative counts never shrink a bar. */
export const segmentTotal = (segments: readonly number[]): number =>
  segments.reduce((sum, v) => sum + Math.max(0, v), 0);

/** Horizontal bar: square at the baseline, rounded data end. */
export const hbar = (
  ctx: Ctx,
  x: number,
  y: number,
  len: number,
  h: number,
  color: string,
): void => {
  const l = Math.max(len, 1.5);
  const r = Math.min(4, l, h / 2);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + l - r, y);
  ctx.arcTo(x + l, y, x + l, y + r, r);
  ctx.lineTo(x + l, y + h - r);
  ctx.arcTo(x + l, y + h, x + l - r, y + h, r);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
};

/** Bar split into coloured segments with hairline gaps and rounded outer ends. */
export const stackedBar = (
  ctx: Ctx,
  x: number,
  y: number,
  len: number,
  h: number,
  segments: readonly number[],
): void => {
  const total = segmentTotal(segments);
  if (total <= 0) return;
  ctx.save();
  roundRect(ctx, x, y, Math.max(len, 3), h, 3);
  ctx.clip();
  let cx = x;
  segments.forEach((value, i) => {
    if (value <= 0) return;
    const w = (value / total) * Math.max(len, 3);
    ctx.fillStyle = segmentColor(i);
    ctx.fillRect(cx, y, Math.max(w - 1.5, 1), h);
    cx += w;
  });
  ctx.restore();
};

export const hline = (ctx: Ctx, x1: number, x2: number, y: number, color: string): void => {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, Math.round(y) + 0.5);
  ctx.lineTo(x2, Math.round(y) + 0.5);
  ctx.stroke();
};

export interface LegendItem {
  readonly name: string;
  readonly color: string;
  readonly kind: 'line' | 'swatch';
}

const keyWidth = (item: LegendItem): number => (item.kind === 'swatch' ? 16 : 22);
const ITEM_GAP = 16;

/** Width `drawLegend` draws for `items`, without the trailing gap. */
export const legendWidth = (ctx: Ctx, items: readonly LegendItem[], size: number): number =>
  items.reduce(
    (sum, item, i) =>
      sum + keyWidth(item) + textWidth(ctx, item.name, size) + (i > 0 ? ITEM_GAP : 0),
    0,
  );

/** Legend keys (short lines or square swatches) with their names. */
export const drawLegend = (
  ctx: Ctx,
  x: number,
  y: number,
  items: readonly LegendItem[],
  size: number,
): void => {
  let cx = x;
  for (const item of items) {
    if (item.kind === 'swatch') {
      roundRect(ctx, cx, y - 5, 10, 10, 2);
      ctx.fillStyle = item.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(cx + 16, y);
      ctx.stroke();
    }
    cx += keyWidth(item);
    drawText(ctx, item.name, cx, y, { size, color: COLOR.body });
    cx += textWidth(ctx, item.name, size) + ITEM_GAP;
  }
};

export const swatchLegend = (names: readonly string[]): LegendItem[] =>
  names.map((name, i) => ({ name, color: segmentColor(i), kind: 'swatch' }));

/** Filled triangle centred on (cx, cy), pointing up or down. */
export const triangle = (ctx: Ctx, cx: number, cy: number, size: number, up: boolean): void => {
  const half = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx, up ? cy - half : cy + half);
  ctx.lineTo(cx + half, up ? cy + half : cy - half);
  ctx.lineTo(cx - half, up ? cy + half : cy - half);
  ctx.closePath();
  ctx.fill();
};
