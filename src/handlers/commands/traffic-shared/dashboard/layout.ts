/**
 * Vertical block layout. Each dashboard is a list of blocks whose heights
 * are measured first (against a scratch context, since text widths can
 * drive wrapping), so the final canvas is exactly as tall as its content.
 */
import { createCanvas, type CanvasRenderingContext2D } from 'canvas';

import { ensureCanvasFont } from '../../../../infra/graphics/canvas-font';
import { drawLegend, type LegendItem } from './shapes';
import { drawFitted, drawText, textWidth } from './text';
import { COLOR, DASHBOARD_WIDTH_PX, INNER_WIDTH, LOGICAL_WIDTH, PAD, SCALE } from './theme';

export type Ctx = CanvasRenderingContext2D;

export interface Block {
  readonly height: number;
  readonly draw: (ctx: Ctx, y: number) => void;
}

const BOTTOM_PAD = 14;
/** Standard vertical gap between sections. */
const SECTION_GAP = 22;
export const TITLE_HEIGHT = 26;

export const spacer = (height: number): Block => ({ height, draw: () => undefined });

let scratch: Ctx | null = null;

const measureContext = (): Ctx => {
  ensureCanvasFont();
  scratch ??= createCanvas(1, 1).getContext('2d');
  return scratch;
};

/** Measure and draw `build`'s blocks top to bottom; returns the PNG bytes. */
export const renderBlocks = (build: (measure: Ctx) => readonly Block[]): Buffer => {
  const blocks = build(measureContext());
  const height = PAD + blocks.reduce((sum, b) => sum + b.height, 0) + BOTTOM_PAD;
  const canvas = createCanvas(DASHBOARD_WIDTH_PX, Math.ceil(height * SCALE));
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = COLOR.embedBg;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, height);
  let y = PAD;
  for (const block of blocks) {
    block.draw(ctx, y);
    y += block.height;
  }
  return canvas.toBuffer('image/png');
};

/** Bold section heading, truncated to `maxWidth`; returns its drawn width. */
export const drawTitle = (
  ctx: Ctx,
  title: string,
  x: number,
  y: number,
  maxWidth: number,
): number => {
  drawFitted(ctx, title, x, y + 9, maxWidth, { size: 15, color: COLOR.ink, bold: true });
  return Math.min(textWidth(ctx, title, 15), maxWidth);
};

export interface TitleExtras {
  readonly legend?: readonly LegendItem[];
  readonly legendSize?: number;
  /** Muted caption after the title (and legend). */
  readonly note?: string;
}

/** Full-width section heading with an optional legend and caption after it. */
export const sectionTitle = (title: string, extras: TitleExtras = {}): Block => ({
  height: TITLE_HEIGHT,
  draw: (ctx, y) => {
    const x = PAD;
    let cx = x + drawTitle(ctx, title, x, y, INNER_WIDTH) + 14;
    if (extras.legend !== undefined) {
      drawLegend(ctx, cx, y + 9, extras.legend, extras.legendSize ?? 13);
      cx = x + INNER_WIDTH;
    }
    if (extras.note !== undefined && cx < x + INNER_WIDTH) {
      drawText(ctx, extras.note, cx, y + 9, { size: 12, color: COLOR.muted });
    }
  },
});

/** A section: one block, several blocks drawn flush, or absent. */
export type Section = Block | readonly Block[] | undefined;

/** Flatten sections into blocks, separated by the standard section gap. */
export const withGaps = (sections: readonly Section[]): Block[] => {
  const groups = sections
    .filter((s): s is Block | readonly Block[] => s !== undefined)
    .map((s): readonly Block[] => ('draw' in s ? [s] : s));
  return groups.flatMap((group, i) => (i === 0 ? [...group] : [spacer(SECTION_GAP), ...group]));
};
