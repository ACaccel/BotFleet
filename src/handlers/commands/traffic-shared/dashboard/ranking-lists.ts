/**
 * Ranked bar lists built for one column: a single top-10 ranking, two
 * rankings side by side at the height of the longer one, and one top-10
 * folded into two five-row halves on a shared scale.
 */
import { ROW_HEIGHT, drawRankBars, rowTotal } from './bars';
import { TITLE_HEIGHT, drawTitle, splitColumn, type Block, type Column, type Ctx } from './layout';
import { drawLegend, type LegendItem } from './shapes';
import { drawFitted } from './text';
import { COLOR, COLUMN_GAP, RANK_ROW_LIMIT } from './theme';
import type { AnyRankRow, RankingColumn } from './types-common';

const NOTE_HEIGHT = 22;
const LEGEND_HEIGHT = 18;
/** Share of a `narrow-wide` pair the narrow (left) list takes. */
const NARROW_SHARE = 0.4;

const drawNote = (ctx: Ctx, note: string | undefined, half: Column, y: number): void => {
  if (note !== undefined)
    drawFitted(ctx, note, half.x, y, half.w, { size: 12, color: COLOR.muted });
};

export interface RankingOptions {
  /** Legend under the title, e.g. the segment colours of a split bar. */
  readonly legend?: readonly LegendItem[];
}

/** One top-10 ranking across the column, with its optional legend and note. */
export const rankingList = (
  column: RankingColumn<AnyRankRow>,
  col: Column,
  options: RankingOptions = {},
): Block => {
  const rows = column.rows.slice(0, RANK_ROW_LIMIT);
  const listH = Math.max(1, rows.length) * ROW_HEIGHT;
  const legendH = options.legend === undefined ? 0 : LEGEND_HEIGHT;
  const noteH = column.note === undefined ? 0 : NOTE_HEIGHT;
  return {
    height: TITLE_HEIGHT + legendH + listH + noteH,
    draw: (ctx, y) => {
      drawTitle(ctx, column.title, col.x, y, col.w);
      if (options.legend !== undefined)
        drawLegend(ctx, col.x, y + TITLE_HEIGHT + 2, options.legend, 12);
      const listY = y + TITLE_HEIGHT + legendH;
      drawRankBars(ctx, col.x, listY, col.w, rows, { ranked: column.ranked ?? true });
      drawNote(ctx, column.note, col, listY + listH + 11);
    },
  };
};

export interface PairOptions extends RankingOptions {
  /** `narrow-wide` gives the right list room for long names and tags. */
  readonly split: 'narrow-wide' | 'even';
}

/** Two rankings side by side, both as tall as the longer one (capped at ten rows). */
export const rankingPair = (
  left: RankingColumn<AnyRankRow>,
  right: RankingColumn<AnyRankRow>,
  col: Column,
  options: PairOptions,
): Block => {
  const avail = col.w - COLUMN_GAP;
  const [l, r] = splitColumn(col, options.split === 'even' ? avail / 2 : avail * NARROW_SHARE);
  const leftRows = left.rows.slice(0, RANK_ROW_LIMIT);
  const rightRows = right.rows.slice(0, RANK_ROW_LIMIT);
  const listH = Math.max(1, leftRows.length, rightRows.length) * ROW_HEIGHT;
  const legendH = options.legend === undefined ? 0 : LEGEND_HEIGHT;
  const noteH = left.note === undefined && right.note === undefined ? 0 : NOTE_HEIGHT;
  return {
    height: TITLE_HEIGHT + legendH + listH + noteH,
    draw: (ctx, y) => {
      drawTitle(ctx, left.title, l.x, y, l.w);
      drawTitle(ctx, right.title, r.x, y, r.w);
      if (options.legend !== undefined)
        drawLegend(ctx, l.x, y + TITLE_HEIGHT + 2, options.legend, 12);
      const listY = y + TITLE_HEIGHT + legendH;
      drawRankBars(ctx, l.x, listY, l.w, leftRows, { ranked: left.ranked ?? true });
      drawRankBars(ctx, r.x, listY, r.w, rightRows, { ranked: right.ranked ?? true });
      drawNote(ctx, left.note, l, listY + listH + 11);
      drawNote(ctx, right.note, r, listY + listH + 11);
    },
  };
};

/** One top-10 ranking folded into two halves (ranks 1-5 and 6-10) on a shared scale. */
export const foldedRanking = (column: RankingColumn<AnyRankRow>, col: Column): Block => {
  const rows = column.rows.slice(0, RANK_ROW_LIMIT);
  const half = Math.max(1, Math.ceil(rows.length / 2));
  const noteH = column.note === undefined ? 0 : NOTE_HEIGHT;
  return {
    height: TITLE_HEIGHT + half * ROW_HEIGHT + noteH,
    draw: (ctx, y) => {
      drawTitle(ctx, column.title, col.x, y, col.w);
      const listY = y + TITLE_HEIGHT;
      const max = Math.max(1, ...rows.map(rowTotal));
      const ranked = column.ranked ?? true;
      const [l, r] = splitColumn(col, (col.w - COLUMN_GAP) / 2);
      drawRankBars(ctx, l.x, listY, l.w, rows.slice(0, half), { ranked, max });
      const rest = rows.slice(half);
      drawRankBars(ctx, r.x, listY, r.w, rest, { ranked, max, rankStart: half + 1 });
      drawNote(ctx, column.note, col, listY + half * ROW_HEIGHT + 11);
    },
  };
};
