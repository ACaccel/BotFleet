/**
 * Ranked bar lists built for one column (at most `RANK_ROW_LIMIT` rows
 * each): a single ranking, and two rankings side by side at the height of
 * the longer one.
 */
import { ROW_HEIGHT, drawRankBars } from './bars';
import {
  TITLE_HEIGHT,
  TITLE_SIZE,
  drawTitle,
  splitColumn,
  type Block,
  type Column,
  type Ctx,
} from './layout';
import { drawLegend, type LegendItem } from './shapes';
import { drawFitted, textWidth } from './text';
import { COLOR, COLUMN_GAP, RANK_ROW_LIMIT } from './theme';
import type { AnyRankRow, RankingColumn } from './types-common';

const NOTE_HEIGHT = 22;
const LEGEND_HEIGHT = 18;
/** Share of a pair the narrow (left) list takes. */
const NARROW_SHARE = 0.4;
/** Room kept after the left title. */
const TITLE_ROOM = 4;

const drawNote = (ctx: Ctx, note: string | undefined, half: Column, y: number): void => {
  if (note !== undefined)
    drawFitted(ctx, note, half.x, y, half.w, { size: 12, color: COLOR.muted });
};

export interface RankingOptions {
  /** Legend under the title, e.g. the segment colours of a split bar. */
  readonly legend?: readonly LegendItem[];
}

/** One ranking across the column, with its optional legend and note. */
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

/**
 * Two rankings side by side, both as tall as the longer one. The right
 * list is the wider, for long channel and thread names with their tags;
 * the left one widens (up to half the pair) so its title is never cut.
 */
export const rankingPair = (
  measure: Ctx,
  left: RankingColumn<AnyRankRow>,
  right: RankingColumn<AnyRankRow>,
  col: Column,
  options: RankingOptions = {},
): Block => {
  const avail = col.w - COLUMN_GAP;
  const titleW = textWidth(measure, left.title, TITLE_SIZE) + TITLE_ROOM;
  const [l, r] = splitColumn(col, Math.min(avail / 2, Math.max(avail * NARROW_SHARE, titleW)));
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
