/**
 * The hero tile: the headline value, its period delta, and the secondary
 * metrics. `inline` draws the metrics beside the value; `stacked` leaves
 * them to a tile row under the hero (see `kpiBlocks`) for narrow columns.
 */
import { roundRect } from '../canvas-primitives';
import type { Block, Column, Ctx } from './layout';
import { triangle } from './shapes';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { COLOR } from './theme';
import type { Delta, HeroTile } from './types-common';

const HERO_HEIGHT = 76;
const INSET = 14;

const DELTA_COLOR: Readonly<Record<Delta['direction'], string>> = {
  up: COLOR.up,
  down: COLOR.down,
  flat: COLOR.muted,
};

const deltaWidth = (ctx: Ctx, delta: Delta): number =>
  Math.max(
    (delta.direction === 'flat' ? 0 : 15) + textWidth(ctx, delta.text, 15),
    textWidth(ctx, delta.sub, 12),
  );

/** Draw the delta block at (x, y); returns its width. */
const drawDelta = (ctx: Ctx, delta: Delta, x: number, y: number): number => {
  const color = DELTA_COLOR[delta.direction];
  let tx = x;
  if (delta.direction !== 'flat') {
    ctx.fillStyle = color;
    triangle(ctx, x + 6, y + 42, 12, delta.direction === 'up');
    tx += 15;
  }
  drawText(ctx, delta.text, tx, y + 42, { size: 15, color, bold: true });
  drawText(ctx, delta.sub, x, y + 60, { size: 12, color: COLOR.muted });
  return deltaWidth(ctx, delta);
};

/** How the hero's secondary metrics are laid out. */
export type HeroLayout = 'inline' | 'stacked';

const drawHeroMetrics = (ctx: Ctx, hero: HeroTile, col: Column, y: number, leftEnd: number) => {
  const right = col.x + col.w - INSET;
  const count = Math.max(1, hero.metrics.length);
  const start = Math.max(leftEnd + 24, col.x + col.w * 0.42);
  const step = Math.min((right - start) / count, col.w * 0.23);
  hero.metrics.forEach((metric, i) => {
    const cx = start + i * step;
    const maxW = step - 8;
    drawFitted(ctx, metric.label, cx, y + 26, maxW, { size: 13, color: COLOR.muted });
    const shown = fitText(ctx, metric.value, maxW, 20);
    drawText(ctx, shown, cx, y + 50, { size: 20, color: COLOR.ink, bold: true });
    if (metric.unit === undefined) return;
    const ux = cx + textWidth(ctx, shown, 20) + 4;
    drawFitted(ctx, metric.unit, ux, y + 52, cx + maxW - ux, { size: 13, color: COLOR.body });
  });
};

/** The hero tile; `stacked` gives the value the room the delta does not take. */
export const heroTile = (hero: HeroTile, col: Column, layout: HeroLayout = 'inline'): Block => ({
  height: HERO_HEIGHT,
  draw: (ctx, y) => {
    const { x, w } = col;
    roundRect(ctx, x, y, w, HERO_HEIGHT, 8);
    ctx.fillStyle = COLOR.tile;
    ctx.fill();
    drawFitted(ctx, hero.label, x + INSET, y + 18, w - 2 * INSET, { size: 13, color: COLOR.muted });
    const deltaRoom = hero.delta === undefined ? 0 : 12 + deltaWidth(ctx, hero.delta);
    const valueMax = layout === 'inline' ? w * 0.4 : w - 2 * INSET - deltaRoom;
    const value = fitText(ctx, hero.value, Math.max(0, valueMax), 32);
    drawText(ctx, value, x + INSET, y + 47, { size: 32, color: COLOR.ink, bold: true });
    let leftEnd = x + INSET + textWidth(ctx, value, 32);
    if (hero.delta !== undefined) leftEnd += 12 + drawDelta(ctx, hero.delta, leftEnd + 12, y);
    if (layout === 'inline') drawHeroMetrics(ctx, hero, col, y, leftEnd);
  },
});
