/**
 * A ranked bar list built for one column (at most `RANK_ROW_LIMIT` rows),
 * with an optional legend and note.
 */
import { ROW_HEIGHT, drawRankBars } from './bars';
import { TITLE_HEIGHT, drawTitle, type Block, type Column, type Ctx } from './layout';
import { drawLegend, type LegendItem } from './shapes';
import { drawFitted } from './text';
import { COLOR, RANK_ROW_LIMIT } from './theme';
import type { AnyRankRow, RankingColumn } from './types-common';

const NOTE_HEIGHT = 22;
const LEGEND_HEIGHT = 18;

const drawNote = (ctx: Ctx, note: string | undefined, col: Column, y: number): void => {
  if (note !== undefined) drawFitted(ctx, note, col.x, y, col.w, { size: 12, color: COLOR.muted });
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
