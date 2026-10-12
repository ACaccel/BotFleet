/**
 * Block primitives. A dashboard column is a list of blocks whose heights
 * are measured first (against a scratch context, since text widths can
 * drive wrapping), so the composer knows every column's natural height
 * before anything is drawn. Every block is built for one `Column`: it
 * draws between `col.x` and `col.x + col.w` and never reads a global width.
 */
import { createCanvas, type CanvasRenderingContext2D } from 'canvas';

import { ensureCanvasFont } from '../../../../infra/graphics/canvas-font';
import { drawLegend, legendWidth, type LegendItem } from './shapes';
import { drawFitted, textWidth } from './text';
import { COLOR, COLUMN_GAP } from './theme';

export type Ctx = CanvasRenderingContext2D;

export interface Block {
  readonly height: number;
  readonly draw: (ctx: Ctx, y: number) => void;
}

/** The horizontal slot a block draws in, in logical pixels. */
export interface Column {
  readonly x: number;
  readonly w: number;
}

/** Halves of a column split at `leftW`, with the standard pair gap between them. */
export const splitColumn = (col: Column, leftW: number): readonly [Column, Column] => [
  { x: col.x, w: leftW },
  { x: col.x + leftW + COLUMN_GAP, w: col.w - leftW - COLUMN_GAP },
];

export const TITLE_HEIGHT = 26;
/** A legend that does not fit beside its title wraps to a line of this height. */
const LEGEND_LINE_HEIGHT = 20;
export const TITLE_SIZE = 15;
const LEGEND_GAP = 14;

export const spacer = (height: number): Block => ({ height, draw: () => undefined });

let scratch: Ctx | null = null;

/** A shared 1 x 1 context for measuring text before the canvas size is known. */
export const measureContext = (): Ctx => {
  ensureCanvasFont();
  scratch ??= createCanvas(1, 1).getContext('2d');
  return scratch;
};

/** Bold section heading, truncated to `maxWidth`; returns its drawn width. */
export const drawTitle = (
  ctx: Ctx,
  title: string,
  x: number,
  y: number,
  maxWidth: number,
): number => {
  drawFitted(ctx, title, x, y + 9, maxWidth, { size: TITLE_SIZE, color: COLOR.ink, bold: true });
  return Math.min(textWidth(ctx, title, TITLE_SIZE), maxWidth);
};

export interface TitleExtras {
  readonly legend?: readonly LegendItem[];
  readonly legendSize?: number;
  /** Muted caption after the title (and legend). */
  readonly note?: string;
}

/**
 * Section heading across the column, with an optional legend and caption
 * after it. A legend too wide to sit beside the title moves to its own line
 * under it, so it never runs past the column.
 */
export const sectionTitle = (
  measure: Ctx,
  col: Column,
  title: string,
  extras: TitleExtras = {},
): Block => {
  const legendSize = extras.legendSize ?? 13;
  const titleW = Math.min(textWidth(measure, title, TITLE_SIZE), col.w);
  const legendW = extras.legend === undefined ? 0 : legendWidth(measure, extras.legend, legendSize);
  const wraps = extras.legend !== undefined && titleW + LEGEND_GAP + legendW > col.w;
  return {
    height: TITLE_HEIGHT + (wraps ? LEGEND_LINE_HEIGHT : 0),
    draw: (ctx, y) => {
      const right = col.x + col.w;
      let cx = col.x + drawTitle(ctx, title, col.x, y, col.w) + LEGEND_GAP;
      if (extras.legend !== undefined) {
        if (wraps) drawLegend(ctx, col.x, y + TITLE_HEIGHT + 4, extras.legend, legendSize);
        else drawLegend(ctx, cx, y + 9, extras.legend, legendSize);
        cx = right;
      }
      if (extras.note !== undefined && cx < right) {
        drawFitted(ctx, extras.note, cx, y + 9, right - cx, { size: 12, color: COLOR.muted });
      }
    },
  };
};

/** A section: one block, several blocks drawn flush, or absent. */
export type Section = Block | readonly Block[] | undefined;

/** The present sections as flush block groups. */
export const groupsOf = (sections: readonly Section[]): (readonly Block[])[] =>
  sections
    .filter((s): s is Block | readonly Block[] => s !== undefined)
    .map((s): readonly Block[] => ('draw' in s ? [s] : s));

export const heightOf = (blocks: readonly Block[]): number =>
  blocks.reduce((sum, b) => sum + b.height, 0);
