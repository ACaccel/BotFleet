/**
 * The heatmap's less-to-more legend: a muted label, the ramp swatches, and
 * the per-cell maximum. The swatches narrow (down to a minimum) so the
 * legend fits its column before any text is cut.
 */
import { roundRect } from '../canvas-primitives';
import type { Column, Ctx } from './layout';
import { drawFitted, drawText, textWidth } from './text';
import { COLOR, formatCount, rampColor } from './theme';
import type { HeatmapSection } from './types-common';

const SIZE = 12;
const RAMP_STEPS = 6;
const SWATCH_MAX = 18;
const SWATCH_MIN = 8;
const SWATCH_GAP = 2;

interface LegendGeometry {
  readonly swatch: number;
  readonly width: number;
}

/** Swatch width that lets the legend fit `w`, and the legend's resulting width. */
export const legendGeometry = (
  ctx: Ctx,
  section: HeatmapSection,
  max: number,
  w: number,
): LegendGeometry => {
  const text =
    textWidth(ctx, section.lessLabel, SIZE) +
    6 +
    4 +
    textWidth(ctx, section.moreLabel(formatCount(max)), SIZE);
  const room = (w - text) / RAMP_STEPS - SWATCH_GAP;
  const swatch = Math.max(SWATCH_MIN, Math.min(SWATCH_MAX, room));
  return { swatch, width: text + RAMP_STEPS * (swatch + SWATCH_GAP) };
};

export const drawLegendRow = (
  ctx: Ctx,
  section: HeatmapSection,
  max: number,
  col: Column,
  y: number,
  swatch: number,
): void => {
  const muted = { size: SIZE, color: COLOR.muted };
  let lx = col.x;
  drawText(ctx, section.lessLabel, lx, y, muted);
  lx += textWidth(ctx, section.lessLabel, SIZE) + 6;
  for (let i = 0; i < RAMP_STEPS; i++) {
    roundRect(ctx, lx, y - 6, swatch, 12, 2);
    ctx.fillStyle = rampColor(i / (RAMP_STEPS - 1));
    ctx.fill();
    lx += swatch + SWATCH_GAP;
  }
  drawFitted(ctx, section.moreLabel(formatCount(max)), lx + 4, y, col.x + col.w - lx - 4, muted);
};
