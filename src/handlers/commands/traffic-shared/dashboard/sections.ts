/**
 * Two-column dashboard sections: interaction key-values beside content
 * bars, paired top-10 rankings of equal height, and a single top-10 list
 * folded into two five-row columns.
 */
import { ROW_HEIGHT, drawBars, drawRankBars, rowTotal } from './bars';
import { TITLE_HEIGHT, drawTitle, type Block, type Ctx } from './layout';
import { drawLegend, hline, type LegendItem } from './shapes';
import { drawRich, drawText, textWidth } from './text';
import { COLOR, COLUMN_GAP, HALF_WIDTH, INNER_WIDTH, PAD, RANK_ROW_LIMIT } from './theme';
import type { AnyRankRow, BarRow, KeyValueRow, RankingColumn, TitledRows } from './types-common';

const NOTE_HEIGHT = 22;
const LEGEND_HEIGHT = 18;
const SECONDARY_INDENT = 18;
/** Narrow members column beside a wide channels column (names plus forum tags). */
const NARROW_WIDTH = 188;

const drawKeyValues = (
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  rows: readonly KeyValueRow[],
): void => {
  rows.forEach((row, i) => {
    const cy = y + i * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (i > 0) hline(ctx, x, x + w, y + i * ROW_HEIGHT, COLOR.grid);
    const secondary = row.secondary === true;
    const style = { size: 14, color: COLOR.ink, bold: !secondary, align: 'right' } as const;
    drawText(ctx, row.value, x + w, cy, style);
    const lx = x + (secondary ? SECONDARY_INDENT : 0);
    const maxW = x + w - textWidth(ctx, row.value, 14) - 8 - lx;
    drawRich(
      ctx,
      row.label,
      lx,
      cy,
      { size: 13, color: secondary ? COLOR.muted : COLOR.body },
      maxW,
    );
  });
};

/** Interaction key-values (left) beside content-type bars (right). */
export const detailPair = (left: TitledRows<KeyValueRow>, right: TitledRows<BarRow>): Block => {
  const rightX = PAD + HALF_WIDTH + COLUMN_GAP;
  const rows = Math.max(left.rows.length, right.rows.length);
  return {
    height: TITLE_HEIGHT + rows * ROW_HEIGHT,
    draw: (ctx, y) => {
      drawTitle(ctx, left.title, PAD, y, HALF_WIDTH);
      drawTitle(ctx, right.title, rightX, y, HALF_WIDTH);
      drawKeyValues(ctx, PAD, y + TITLE_HEIGHT, HALF_WIDTH, left.rows);
      drawBars(ctx, rightX, y + TITLE_HEIGHT, HALF_WIDTH, right.rows);
    },
  };
};

const drawNote = (ctx: Ctx, note: string | undefined, x: number, y: number): void => {
  if (note !== undefined) drawText(ctx, note, x, y, { size: 12, color: COLOR.muted });
};

export interface PairOptions {
  /** `narrow-wide` gives the right column room for long names and tags. */
  readonly split: 'narrow-wide' | 'even';
  readonly legend?: readonly LegendItem[];
}

/** Two rankings side by side, both as tall as the longer one (capped at ten rows). */
export const rankingPair = (
  left: RankingColumn<AnyRankRow>,
  right: RankingColumn<AnyRankRow>,
  options: PairOptions,
): Block => {
  const leftW = options.split === 'even' ? HALF_WIDTH : NARROW_WIDTH;
  const rightX = PAD + leftW + COLUMN_GAP;
  const rightW = INNER_WIDTH - leftW - COLUMN_GAP;
  const leftRows = left.rows.slice(0, RANK_ROW_LIMIT);
  const rightRows = right.rows.slice(0, RANK_ROW_LIMIT);
  const listH = Math.max(1, leftRows.length, rightRows.length) * ROW_HEIGHT;
  const legendH = options.legend === undefined ? 0 : LEGEND_HEIGHT;
  const noteH = left.note === undefined && right.note === undefined ? 0 : NOTE_HEIGHT;
  return {
    height: TITLE_HEIGHT + legendH + listH + noteH,
    draw: (ctx, y) => {
      drawTitle(ctx, left.title, PAD, y, leftW);
      drawTitle(ctx, right.title, rightX, y, rightW);
      if (options.legend !== undefined)
        drawLegend(ctx, PAD, y + TITLE_HEIGHT + 2, options.legend, 12);
      const listY = y + TITLE_HEIGHT + legendH;
      drawRankBars(ctx, PAD, listY, leftW, leftRows, { ranked: left.ranked ?? true });
      drawRankBars(ctx, rightX, listY, rightW, rightRows, { ranked: right.ranked ?? true });
      drawNote(ctx, left.note, PAD, listY + listH + 11);
      drawNote(ctx, right.note, rightX, listY + listH + 11);
    },
  };
};

/** One top-10 ranking folded into two columns (ranks 1-5 and 6-10) on a shared scale. */
export const foldedRanking = (column: RankingColumn<AnyRankRow>): Block => {
  const rows = column.rows.slice(0, RANK_ROW_LIMIT);
  const half = Math.max(1, Math.ceil(rows.length / 2));
  const noteH = column.note === undefined ? 0 : NOTE_HEIGHT;
  return {
    height: TITLE_HEIGHT + half * ROW_HEIGHT + noteH,
    draw: (ctx, y) => {
      drawTitle(ctx, column.title, PAD, y, INNER_WIDTH);
      const listY = y + TITLE_HEIGHT;
      const max = Math.max(1, ...rows.map(rowTotal));
      const ranked = column.ranked ?? true;
      drawRankBars(ctx, PAD, listY, HALF_WIDTH, rows.slice(0, half), { ranked, max });
      const rightX = PAD + HALF_WIDTH + COLUMN_GAP;
      const rest = rows.slice(half);
      drawRankBars(ctx, rightX, listY, HALF_WIDTH, rest, { ranked, max, rankStart: half + 1 });
      drawNote(ctx, column.note, PAD, listY + half * ROW_HEIGHT + 11);
    },
  };
};
