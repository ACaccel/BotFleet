/**
 * KPI tiles: the hero tile with its tile rows, and rows of small stat
 * tiles with flexible widths. In a narrow column the hero's metrics move
 * out of the hero into a tile row of their own.
 */
import { roundRect } from '../canvas-primitives';
import { heroTile, type HeroLayout } from './hero';
import { spacer, type Block, type Column, type Ctx } from './layout';
import { drawFitted, drawRich, drawText, fitText, textWidth } from './text';
import { COLOR } from './theme';
import type { HeroTile, StatTile } from './types-common';

const TILE_HEIGHT = 70;
const TILE_GAP = 8;

const MIN_FLEX = 0.25;

/** A missing, non-finite, or tiny weight must not collapse a tile to nothing. */
const flexOf = (tile: StatTile): number =>
  tile.flex === undefined || !Number.isFinite(tile.flex) ? 1 : Math.max(MIN_FLEX, tile.flex);

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

/** One row of stat tiles sharing the column width by their `flex` weights. */
const tileRow = (tiles: readonly StatTile[], col: Column): Block => ({
  height: TILE_HEIGHT,
  draw: (ctx, y) => {
    if (tiles.length === 0) return;
    const avail = col.w - (tiles.length - 1) * TILE_GAP;
    const flexSum = tiles.reduce((sum, t) => sum + flexOf(t), 0);
    let cx = col.x;
    for (const tile of tiles) {
      const w = (avail * flexOf(tile)) / flexSum;
      drawTile(ctx, tile, cx, y, w);
      cx += w + TILE_GAP;
    }
  },
});

/**
 * Hero tile followed by tile rows, separated by the tight tile gap. With
 * the `stacked` layout the hero's metrics form the first tile row.
 */
export const kpiBlocks = (
  hero: HeroTile,
  rows: readonly (readonly StatTile[])[],
  col: Column,
  layout: HeroLayout = 'inline',
): Block[] => {
  const metricRow: StatTile[] =
    layout === 'stacked'
      ? hero.metrics.map((m) => ({
          label: m.label,
          value: m.value,
          ...(m.unit === undefined ? {} : { unit: m.unit }),
        }))
      : [];
  return [
    heroTile(hero, col, layout),
    ...[metricRow, ...rows]
      .filter((row) => row.length > 0)
      .flatMap((row) => [spacer(TILE_GAP), tileRow(row, col)]),
  ];
};

/** Most tiles a narrow column fits in one row. */
const TILES_PER_ROW = 3;

/**
 * Flat tiles wrapped into rows of at most three, the fuller rows last
 * (five tiles make rows of two and three), separated by the tile gap.
 */
export const tileRows = (tiles: readonly StatTile[], col: Column): Block[] => {
  const count = Math.ceil(tiles.length / TILES_PER_ROW);
  const rows: StatTile[][] = [];
  let start = 0;
  for (let r = 0; r < count; r++) {
    const size =
      Math.floor((tiles.length * (r + 1)) / count) - Math.floor((tiles.length * r) / count);
    rows.push(tiles.slice(start, start + size));
    start += size;
  }
  return rows.flatMap((row, i) =>
    i === 0 ? [tileRow(row, col)] : [spacer(TILE_GAP), tileRow(row, col)],
  );
};
