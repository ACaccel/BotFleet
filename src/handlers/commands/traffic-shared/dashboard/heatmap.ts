/**
 * Weekday x hour activity heatmap on a sequential one-hue ramp, with an
 * hour axis, a less-to-more legend, and the peak cell caption. The caption
 * sits right-aligned on the legend line when both fit the column, and on
 * its own line under the legend otherwise; the legend's ramp swatches
 * narrow before its text is cut.
 */
import { roundRect } from '../canvas-primitives';
import { drawLegendRow, legendGeometry } from './heatmap-legend';
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { drawFitted, drawText, textWidth } from './text';
import { COLOR, rampColor } from './theme';
import type { HeatmapSection } from './types-common';

const DAYS = 7;
const HOURS = 24;
const CELL_HEIGHT = 15;
const ROW_LABEL_WIDTH = 34;
const SIZE = 12;
const GAP = 2;
const AXIS_HEIGHT = 20;
const LEGEND_HEIGHT = 24;
/** Extra height when the peak caption takes its own line. */
export const PEAK_LINE_HEIGHT = 18;
const GRID_HEIGHT = DAYS * CELL_HEIGHT + AXIS_HEIGHT + LEGEND_HEIGHT;
/** Room kept between the legend and an inline peak caption. */
const CAPTION_GAP = 16;

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

const drawGrid = (
  ctx: Ctx,
  section: HeatmapSection,
  col: Column,
  y: number,
  captionOwnLine: boolean,
): void => {
  const cellW = (col.w - ROW_LABEL_WIDTH) / HOURS;
  const peak = peakCell(section.grid);
  const scale = Math.max(1, peak.max);
  const left = col.x + ROW_LABEL_WIDTH;
  section.grid.forEach((row, day) => {
    const cy = y + day * CELL_HEIGHT;
    const label = section.weekdayLabels[day] ?? '';
    const labelStyle = { size: SIZE, color: COLOR.muted };
    drawFitted(ctx, label, col.x, cy + CELL_HEIGHT / 2, ROW_LABEL_WIDTH - 4, labelStyle);
    row.forEach((v, hour) => {
      roundRect(ctx, left + hour * cellW, cy, cellW - GAP, CELL_HEIGHT - GAP, 2);
      ctx.fillStyle = rampColor(Math.max(0, v) / scale);
      ctx.fill();
    });
  });
  const axisY = y + DAYS * CELL_HEIGHT + 10;
  for (let hour = 0; hour < HOURS; hour += 3) {
    const hx = left + hour * cellW + (cellW - GAP) / 2;
    drawText(ctx, String(hour), hx, axisY, { size: SIZE, color: COLOR.muted, align: 'center' });
  }
  const legendY = y + DAYS * CELL_HEIGHT + AXIS_HEIGHT + 12;
  const { swatch } = legendGeometry(ctx, section, peak.max, col.w);
  drawLegendRow(ctx, section, peak.max, col, legendY, swatch);
  if (peak.max === 0) return;
  const caption = section.peakLabel(section.weekdayLabels[peak.day] ?? '', peak.hour);
  const style = { size: SIZE, color: COLOR.body } as const;
  if (captionOwnLine) drawFitted(ctx, caption, col.x, legendY + PEAK_LINE_HEIGHT + 2, col.w, style);
  else drawText(ctx, caption, col.x + col.w, legendY, { ...style, align: 'right' });
};

/** Whether the peak caption needs its own line in this column. */
const captionNeedsLine = (measure: Ctx, section: HeatmapSection, col: Column): boolean => {
  const peak = peakCell(section.grid);
  if (peak.max === 0) return false;
  const caption = section.peakLabel(section.weekdayLabels[peak.day] ?? '', peak.hour);
  const legend = legendGeometry(measure, section, peak.max, col.w);
  return legend.width + CAPTION_GAP + textWidth(measure, caption, SIZE) > col.w;
};

/**
 * Section title plus the heatmap.
 * @throws {RangeError} When the grid is not 7 x 24 or there are not seven weekday labels.
 */
export const heatmapBlocks = (measure: Ctx, section: HeatmapSection, col: Column): Block[] => {
  assertShape(section);
  const ownLine = captionNeedsLine(measure, section, col);
  return [
    sectionTitle(measure, col, section.title),
    {
      height: GRID_HEIGHT + (ownLine ? PEAK_LINE_HEIGHT : 0),
      draw: (ctx, y) => drawGrid(ctx, section, col, y, ownLine),
    },
  ];
};
