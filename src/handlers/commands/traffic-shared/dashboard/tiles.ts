/**
 * KPI tiles: the hero tile (big value, period delta, secondary metrics)
 * and rows of small stat tiles with flexible widths.
 */
import { roundRect } from '../canvas-primitives';
import { spacer, type Block, type Ctx } from './layout';
import { triangle } from './shapes';
import { drawFitted, drawRich, drawText, fitText, textWidth } from './text';
import { COLOR, INNER_WIDTH, PAD } from './theme';
import type { Delta, HeroTile, StatTile } from './types-common';

const HERO_HEIGHT = 76;
const TILE_HEIGHT = 70;
const TILE_GAP = 8;

const MIN_FLEX = 0.25;

const DELTA_COLOR: Readonly<Record<Delta['direction'], string>> = {
  up: COLOR.up,
  down: COLOR.down,
  flat: COLOR.muted,
};

/** A missing, non-finite, or tiny weight must not collapse a tile to nothing. */
const flexOf = (tile: StatTile): number =>
  tile.flex === undefined || !Number.isFinite(tile.flex) ? 1 : Math.max(MIN_FLEX, tile.flex);

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
  return Math.max(tx - x + textWidth(ctx, delta.text, 15), textWidth(ctx, delta.sub, 12));
};

export const heroTile = (hero: HeroTile): Block => ({
  height: HERO_HEIGHT,
  draw: (ctx, y) => {
    const x = PAD;
    const right = x + INNER_WIDTH - 14;
    roundRect(ctx, x, y, INNER_WIDTH, HERO_HEIGHT, 8);
    ctx.fillStyle = COLOR.tile;
    ctx.fill();
    drawText(ctx, hero.label, x + 14, y + 18, { size: 13, color: COLOR.muted });
    const value = fitText(ctx, hero.value, INNER_WIDTH * 0.4, 32);
    drawText(ctx, value, x + 14, y + 47, { size: 32, color: COLOR.ink, bold: true });
    let leftEnd = x + 14 + textWidth(ctx, value, 32);
    if (hero.delta !== undefined) leftEnd += 12 + drawDelta(ctx, hero.delta, leftEnd + 12, y);
    const count = Math.max(1, hero.metrics.length);
    const start = Math.max(leftEnd + 24, x + INNER_WIDTH * 0.42);
    const step = Math.min((right - start) / count, INNER_WIDTH * 0.23);
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
  },
});

const drawTile = (ctx: Ctx, tile: StatTile, x: number, y: number, w: number): void => {
  roundRect(ctx, x, y, w, TILE_HEIGHT, 8);
  ctx.fillStyle = COLOR.tile;
  ctx.fill();
  const maxW = w - 14;
  drawFitted(ctx, tile.label, x + 12, y + 17, maxW, { size: 13, color: COLOR.muted });
  const value = fitText(ctx, tile.value, maxW, 19);
  drawText(ctx, value, x + 12, y + 38, { size: 19, color: COLOR.ink, bold: true });
  if (tile.unit !== undefined) {
    const ux = x + 12 + textWidth(ctx, value, 19) + 4;
    drawFitted(ctx, tile.unit, ux, y + 40, x + 12 + maxW - ux, { size: 13, color: COLOR.body });
  }
  if (tile.sub !== undefined) {
    const style = { size: 12, color: COLOR.muted };
    drawRich(ctx, tile.sub, x + 12, y + TILE_HEIGHT - 13, style, maxW);
  }
};

/** One row of stat tiles sharing the inner width by their `flex` weights. */
export const tileRow = (tiles: readonly StatTile[]): Block => ({
  height: TILE_HEIGHT,
  draw: (ctx, y) => {
    if (tiles.length === 0) return;
    const avail = INNER_WIDTH - (tiles.length - 1) * TILE_GAP;
    const flexSum = tiles.reduce((sum, t) => sum + flexOf(t), 0);
    let cx = PAD;
    for (const tile of tiles) {
      const w = (avail * flexOf(tile)) / flexSum;
      drawTile(ctx, tile, cx, y, w);
      cx += w + TILE_GAP;
    }
  },
});

/** Hero tile followed by tile rows, separated by the tight tile gap. */
export const kpiBlocks = (hero: HeroTile, rows: readonly (readonly StatTile[])[]): Block[] => [
  heroTile(hero),
  ...rows.filter((row) => row.length > 0).flatMap((row) => [spacer(TILE_GAP), tileRow(row)]),
];
