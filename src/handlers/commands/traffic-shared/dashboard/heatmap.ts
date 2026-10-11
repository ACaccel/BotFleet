/**
 * Weekday x hour activity heatmap on a sequential one-hue ramp, with an
 * hour axis, a less-to-more legend, and the peak cell caption.
 */
import { roundRect } from '../canvas-primitives';
import { sectionTitle, type Block, type Ctx } from './layout';
import { drawFitted, drawText, textWidth } from './text';
import { COLOR, INNER_WIDTH, PAD, formatCount, rampColor } from './theme';
import type { HeatmapSection } from './types-common';

const DAYS = 7;
const HOURS = 24;
const CELL_HEIGHT = 15;
const ROW_LABEL_WIDTH = 34;
const SIZE = 12;
const GAP = 2;
const AXIS_HEIGHT = 20;
const LEGEND_HEIGHT = 24;
const GRID_HEIGHT = DAYS * CELL_HEIGHT + AXIS_HEIGHT + LEGEND_HEIGHT;

const assertShape = (section: HeatmapSection): void => {
  const valid =
    section.grid.length === DAYS &&
    section.grid.every((row) => row.length === HOURS) &&
    section.weekdayLabels.length === DAYS;
  if (!valid) {
    throw new RangeError('Heatmap needs 7 weekday labels and 7 rows of 24 hourly counts');
  }
};

const peakCell = (
  grid: readonly (readonly number[])[],
): { day: number; hour: number; max: number } => {
  let peak = { day: 0, hour: 0, max: 0 };
  grid.forEach((row, day) =>
    row.forEach((v, hour) => {
      if (v > peak.max) peak = { day, hour, max: v };
    }),
  );
  return peak;
};

const drawLegendRow = (ctx: Ctx, section: HeatmapSection, max: number, y: number): void => {
  const muted = { size: SIZE, color: COLOR.muted };
  let lx = PAD;
  drawText(ctx, section.lessLabel, lx, y, muted);
  lx += textWidth(ctx, section.lessLabel, SIZE) + 6;
  for (let i = 0; i < 6; i++) {
    roundRect(ctx, lx, y - 6, 18, 12, 2);
    ctx.fillStyle = rampColor(i / 5);
    ctx.fill();
    lx += 20;
  }
  drawText(ctx, section.moreLabel(formatCount(max)), lx + 4, y, muted);
};

const drawGrid = (ctx: Ctx, section: HeatmapSection, y: number): void => {
  const cellW = (INNER_WIDTH - ROW_LABEL_WIDTH) / HOURS;
  const peak = peakCell(section.grid);
  const scale = Math.max(1, peak.max);
  section.grid.forEach((row, day) => {
    const cy = y + day * CELL_HEIGHT;
    const label = section.weekdayLabels[day] ?? '';
    const labelStyle = { size: SIZE, color: COLOR.muted };
    drawFitted(ctx, label, PAD, cy + CELL_HEIGHT / 2, ROW_LABEL_WIDTH - 4, labelStyle);
    row.forEach((v, hour) => {
      roundRect(ctx, PAD + ROW_LABEL_WIDTH + hour * cellW, cy, cellW - GAP, CELL_HEIGHT - GAP, 2);
      ctx.fillStyle = rampColor(Math.max(0, v) / scale);
      ctx.fill();
    });
  });
  const axisY = y + DAYS * CELL_HEIGHT + 10;
  for (let hour = 0; hour < HOURS; hour += 3) {
    const hx = PAD + ROW_LABEL_WIDTH + hour * cellW + (cellW - GAP) / 2;
    drawText(ctx, String(hour), hx, axisY, { size: SIZE, color: COLOR.muted, align: 'center' });
  }
  const legendY = y + DAYS * CELL_HEIGHT + AXIS_HEIGHT + 12;
  drawLegendRow(ctx, section, peak.max, legendY);
  if (peak.max > 0) {
    const caption = section.peakLabel(section.weekdayLabels[peak.day] ?? '', peak.hour);
    const style = { size: SIZE, color: COLOR.body, align: 'right' } as const;
    drawText(ctx, caption, PAD + INNER_WIDTH, legendY, style);
  }
};

/**
 * Section title plus the heatmap.
 * @throws {RangeError} When the grid is not 7 x 24 or there are not seven weekday labels.
 */
export const heatmapBlocks = (section: HeatmapSection): Block[] => {
  assertShape(section);
  return [
    sectionTitle(section.title),
    { height: GRID_HEIGHT, draw: (ctx, y) => drawGrid(ctx, section, y) },
  ];
};
