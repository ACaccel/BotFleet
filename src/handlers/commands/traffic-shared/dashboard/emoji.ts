/**
 * Custom-emoji dashboard in two columns: the summary tiles above
 * the pictures of emoji nobody used, beside the top 20 flowing down two
 * halves (art, name, animated chip, total, and a content / reaction split
 * bar).
 */
import { renderColumns } from './columns';
import { EMOJI_ROW_HEIGHT, drawCell } from './emoji-cell';
import { sectionTitle, splitColumn, type Block, type Column, type Ctx } from './layout';
import { hline, swatchLegend } from './shapes';
import { drawText } from './text';
import { COLOR, COLUMN_GAP } from './theme';
import { tileRows } from './tiles';
import { unusedBlocks } from './unused';
import type { EmojiDashboard, EmojiRanking } from './types';

/** Two halves of at most ten rows each. */
export const EMOJI_RANK_LIMIT = 20;

const NOTE_HEIGHT = 22;
/**
 * Halves as narrow as a cell allows: the image is wider than 4:3, so Discord
 * fits it by width and every pixel of width saved enlarges the text.
 */
const SUMMARY_WIDTH = 200;
const RANKING_WIDTH = 480;
/** Picture rows that keep the summary column no taller than a full ranking. */
const UNUSED_ROWS = 7;
const UNUSED_SIZE = 26;

/** Rows per half: the shown rows split evenly, ranks 1..n down the left half first. */
const rowsPerHalf = (count: number): number => Math.max(1, Math.ceil(count / 2));

const rankingBlocks = (measure: Ctx, ranking: EmojiRanking, col: Column): Block[] => {
  const rows = ranking.rows.slice(0, EMOJI_RANK_LIMIT);
  const perHalf = rowsPerHalf(rows.length);
  const noteH = ranking.note === undefined ? 0 : NOTE_HEIGHT;
  const legend = swatchLegend([ranking.contentLabel, ranking.reactionLabel]);
  const halves = splitColumn(col, (col.w - COLUMN_GAP) / 2);
  return [
    sectionTitle(measure, col, ranking.title, { legend, legendSize: 12 }),
    {
      height: 4 + perHalf * EMOJI_ROW_HEIGHT + noteH,
      draw: (ctx, y) => {
        const top = y + 4;
        rows.forEach((row, i) => {
          const half = halves[Math.floor(i / perHalf)] ?? col;
          const cy = top + (i % perHalf) * EMOJI_ROW_HEIGHT;
          drawCell(ctx, row, i + 1, ranking.animatedTag, half, cy);
        });
        halves.forEach((half, h) => {
          const inHalf = Math.min(perHalf, rows.length - h * perHalf);
          for (let r = 1; r < inHalf; r++) {
            hline(ctx, half.x, half.x + half.w, top + r * EMOJI_ROW_HEIGHT, COLOR.grid);
          }
        });
        if (ranking.note === undefined) return;
        const noteY = top + perHalf * EMOJI_ROW_HEIGHT + 15;
        drawText(ctx, ranking.note, col.x, noteY, { size: 12, color: COLOR.muted });
      },
    },
  ];
};

export const renderEmojiDashboard = (data: EmojiDashboard): Buffer =>
  renderColumns([
    {
      width: SUMMARY_WIDTH,
      sections: (col, measure) => [
        data.tiles.length > 0 ? tileRows(data.tiles, col) : undefined,
        data.unused === undefined
          ? undefined
          : unusedBlocks(measure, data.unused, col, UNUSED_ROWS, UNUSED_SIZE),
      ],
    },
    {
      width: RANKING_WIDTH,
      sections: (col, measure) => [rankingBlocks(measure, data.ranking, col)],
    },
  ]);
