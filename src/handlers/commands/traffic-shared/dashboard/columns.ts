/**
 * Landscape column composer. A dashboard is two or three side-by-side
 * columns, each a list of sections built for its own `Column`. All columns
 * share one height: the tallest column's, but never less than a 16:9
 * canvas, so short data still renders at a readable size in Discord. A
 * column that can grow (a taller trend chart) is rebuilt with the spare
 * height; any other column spreads the spare height over its section
 * gaps so the columns end on one baseline, or, when that would pull its
 * sections far apart, keeps the standard gaps and leaves the space below.
 */
import { createCanvas } from 'canvas';

import {
  groupsOf,
  heightOf,
  measureContext,
  type Block,
  type Column,
  type Ctx,
  type Section,
} from './layout';
import { COLOR, PAD, SCALE } from './theme';

/** Standard vertical gap between sections. */
export const SECTION_GAP = 22;
/** Horizontal gap between columns; a hairline divider sits in its middle. */
export const COLUMN_SPACING = 24;
const BOTTOM_PAD = 14;
/** The canvas is never wider than this ratio. */
const MAX_ASPECT = 16 / 9;
/** A section gap stretches by at most this much to align a column's bottom. */
const MAX_GAP_SPREAD = 80;

export interface ColumnSpec {
  /** Logical width of the column. */
  readonly width: number;
  /**
   * The column's sections. `extra` is spare height for a column marked
   * `grows`; it is 0 on the first, measuring pass.
   */
  readonly sections: (col: Column, measure: Ctx, extra: number) => readonly Section[];
  /** The sections absorb `extra` themselves (e.g. a taller chart). */
  readonly grows?: boolean;
}

interface Built {
  readonly col: Column;
  readonly groups: readonly (readonly Block[])[];
  readonly natural: number;
}

const naturalHeight = (groups: readonly (readonly Block[])[]): number =>
  groups.reduce((sum, g) => sum + heightOf(g), 0) + SECTION_GAP * Math.max(0, groups.length - 1);

const build = (spec: ColumnSpec, col: Column, measure: Ctx, extra: number): Built => {
  const groups = groupsOf(spec.sections(col, measure, extra));
  return { col, groups, natural: naturalHeight(groups) };
};

/** Logical canvas width for columns of these widths. */
export const canvasWidth = (widths: readonly number[]): number =>
  2 * PAD + widths.reduce((sum, w) => sum + w, 0) + COLUMN_SPACING * (widths.length - 1);

/** The gap between this column's sections once it is stretched to `height`. */
const gapFor = (built: Built, height: number): number => {
  const gaps = built.groups.length - 1;
  if (gaps <= 0) return SECTION_GAP;
  const spread = (height - built.natural) / gaps;
  return spread > 0 && spread <= MAX_GAP_SPREAD ? SECTION_GAP + spread : SECTION_GAP;
};

/** Measure, equalise and draw the columns; returns the PNG bytes. */
export const renderColumns = (specs: readonly ColumnSpec[]): Buffer => {
  const measure = measureContext();
  const width = canvasWidth(specs.map((s) => s.width));
  let x = PAD;
  const first = specs.map((spec) => {
    const built = build(spec, { x, w: spec.width }, measure, 0);
    x += spec.width + COLUMN_SPACING;
    return built;
  });
  const floor = Math.ceil(width / MAX_ASPECT) - PAD - BOTTOM_PAD;
  const height = Math.max(floor, ...first.map((b) => b.natural));
  const columns = first.map((built, i) => {
    const spec = specs[i];
    return spec?.grows === true && built.natural < height
      ? build(spec, built.col, measure, height - built.natural)
      : built;
  });

  const canvas = createCanvas(
    Math.round(width * SCALE),
    Math.ceil((PAD + height + BOTTOM_PAD) * SCALE),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = COLOR.embedBg;
  ctx.fillRect(0, 0, width, PAD + height + BOTTOM_PAD);
  columns.forEach((built, i) => {
    if (i > 0) {
      ctx.fillStyle = COLOR.grid;
      ctx.fillRect(built.col.x - COLUMN_SPACING / 2 - 0.5, PAD, 1, height);
    }
    const gap = gapFor(built, height);
    let y = PAD;
    built.groups.forEach((group, g) => {
      if (g > 0) y += gap;
      for (const block of group) {
        block.draw(ctx, y);
        y += block.height;
      }
    });
  });
  return canvas.toBuffer('image/png');
};
