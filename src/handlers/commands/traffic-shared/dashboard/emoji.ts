/**
 * Custom-emoji dashboard: summary tiles, the top 20 as two ten-row
 * columns (art, name, animated chip, total, and a content / reaction
 * split bar), and the chips of emoji nobody used.
 */
import { roundRect } from '../canvas-primitives';
import { drawArt } from './art';
import { unusedBlocks } from './chips';
import { renderBlocks, sectionTitle, withGaps, type Block, type Ctx } from './layout';
import { hline, swatchLegend } from './shapes';
import { drawText, fitText, textWidth } from './text';
import { COLOR, COLUMN_GAP, HALF_WIDTH, PAD, RANK_ROW_LIMIT, formatCount } from './theme';
import { tileRow } from './tiles';
import type { EmojiDashboard, EmojiRanking, EmojiRankRow } from './types';

/** Two columns of `RANK_ROW_LIMIT` rows each. */
export const EMOJI_RANK_LIMIT = RANK_ROW_LIMIT * 2;

const ROW_HEIGHT = 46;
const SPLIT_BAR_WIDTH = 92;
const NOTE_HEIGHT = 22;

const initialsOf = (label: string): string =>
  Array.from(label.replace(/^:+|:+$/g, ''))
    .slice(0, 2)
    .join('');

const drawSplitBar = (ctx: Ctx, row: EmojiRankRow, x: number, cy: number): void => {
  const total = row.inContent + row.inReactions;
  ctx.save();
  roundRect(ctx, x, cy - 3, SPLIT_BAR_WIDTH, 6, 3);
  ctx.clip();
  ctx.fillStyle = COLOR.grid;
  ctx.fillRect(x, cy - 3, SPLIT_BAR_WIDTH, 6);
  if (total > 0) {
    const contentW = (row.inContent / total) * SPLIT_BAR_WIDTH;
    ctx.fillStyle = COLOR.current;
    ctx.fillRect(x, cy - 3, Math.max(contentW - 1, 0), 6);
    ctx.fillStyle = COLOR.amber;
    ctx.fillRect(x + contentW, cy - 3, SPLIT_BAR_WIDTH - contentW, 6);
  }
  ctx.restore();
  const small = (color: string) => ({ size: 11, color }) as const;
  const nx = x + SPLIT_BAR_WIDTH + 8;
  const contentText = formatCount(row.inContent);
  const cw = textWidth(ctx, contentText, 11);
  drawText(ctx, contentText, nx, cy, small(COLOR.current));
  drawText(ctx, '·', nx + cw + 6, cy, { ...small(COLOR.muted), align: 'center' });
  drawText(ctx, formatCount(row.inReactions), nx + cw + 12, cy, small(COLOR.amber));
};

const drawGifTag = (ctx: Ctx, tag: string, x: number, cy: number): number => {
  const w = textWidth(ctx, tag, 9) + 10;
  roundRect(ctx, x, cy - 7, w, 14, 3);
  ctx.fillStyle = COLOR.base;
  ctx.fill();
  drawText(ctx, tag, x + w / 2, cy + 0.5, {
    size: 9,
    color: COLOR.ink,
    bold: true,
    align: 'center',
  });
  return w;
};

const drawCell = (
  ctx: Ctx,
  row: EmojiRankRow,
  rank: number,
  tag: string,
  x: number,
  y: number,
): void => {
  const cy = y + ROW_HEIGHT / 2;
  drawText(ctx, String(rank), x, cy, { size: 13, color: COLOR.muted });
  drawArt(
    ctx,
    { image: row.image, name: row.label, initials: initialsOf(row.label) },
    x + 20,
    cy - 15,
    30,
    7,
  );
  const tx = x + 60;
  const l1 = y + 14;
  const total = formatCount(row.inContent + row.inReactions);
  const right = x + HALF_WIDTH;
  drawText(ctx, total, right, l1, { size: 14, color: COLOR.ink, bold: true, align: 'right' });
  const tagReserve = row.animated ? textWidth(ctx, tag, 9) + 16 : 0;
  const name = fitText(ctx, row.label, right - textWidth(ctx, total, 14) - 8 - tagReserve - tx, 13);
  drawText(ctx, name, tx, l1, { size: 13, color: COLOR.ink });
  if (row.animated) drawGifTag(ctx, tag, tx + textWidth(ctx, name, 13) + 6, l1);
  drawSplitBar(ctx, row, tx, y + 33);
};

const rankingBlocks = (ranking: EmojiRanking): Block[] => {
  const rows = ranking.rows.slice(0, EMOJI_RANK_LIMIT);
  const perColumn = Math.max(1, Math.min(RANK_ROW_LIMIT, rows.length));
  const noteH = ranking.note === undefined ? 0 : NOTE_HEIGHT;
  const legend = swatchLegend([ranking.contentLabel, ranking.reactionLabel]);
  return [
    sectionTitle(ranking.title, { legend, legendSize: 12 }),
    {
      height: 4 + perColumn * ROW_HEIGHT + noteH,
      draw: (ctx, y) => {
        const top = y + 4;
        rows.forEach((row, i) => {
          const x = PAD + Math.floor(i / RANK_ROW_LIMIT) * (HALF_WIDTH + COLUMN_GAP);
          drawCell(
            ctx,
            row,
            i + 1,
            ranking.animatedTag,
            x,
            top + (i % RANK_ROW_LIMIT) * ROW_HEIGHT,
          );
        });
        const rightX = PAD + HALF_WIDTH + COLUMN_GAP;
        for (let r = 1; r < perColumn; r++) {
          hline(ctx, PAD, PAD + HALF_WIDTH, top + r * ROW_HEIGHT, COLOR.grid);
          if (rows.length > RANK_ROW_LIMIT + r) {
            hline(ctx, rightX, rightX + HALF_WIDTH, top + r * ROW_HEIGHT, COLOR.grid);
          }
        }
        if (ranking.note === undefined) return;
        const noteY = top + perColumn * ROW_HEIGHT + 15;
        drawText(ctx, ranking.note, PAD, noteY, { size: 12, color: COLOR.muted });
      },
    },
  ];
};

export const renderEmojiDashboard = (data: EmojiDashboard): Buffer =>
  renderBlocks((measure) =>
    withGaps([
      data.tiles.length > 0 ? tileRow(data.tiles) : undefined,
      rankingBlocks(data.ranking),
      data.unused === undefined ? undefined : unusedBlocks(measure, data.unused),
    ]),
  );
