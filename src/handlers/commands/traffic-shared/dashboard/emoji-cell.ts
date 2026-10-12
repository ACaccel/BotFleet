/**
 * One cell of the emoji ranking: rank, art (or a placeholder seeded by the
 * name), the name with an animated chip, the total, and a content /
 * reaction split bar with both counts.
 */
import { roundRect } from '../canvas-primitives';
import { drawArt } from './art';
import type { Column, Ctx } from './layout';
import { drawText, fitText, textWidth } from './text';
import { COLOR, formatCount } from './theme';
import type { EmojiRankRow } from './types';

/** Height of one cell. */
export const EMOJI_ROW_HEIGHT = 46;
const SPLIT_BAR_WIDTH = 92;

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

/** One ranked emoji: rank, art, name with its GIF chip, total, and the split bar. */
export const drawCell = (
  ctx: Ctx,
  row: EmojiRankRow,
  rank: number,
  tag: string,
  cell: Column,
  y: number,
): void => {
  const { x } = cell;
  const cy = y + EMOJI_ROW_HEIGHT / 2;
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
  const right = x + cell.w;
  drawText(ctx, total, right, l1, { size: 14, color: COLOR.ink, bold: true, align: 'right' });
  const tagReserve = row.animated ? textWidth(ctx, tag, 9) + 16 : 0;
  const name = fitText(ctx, row.label, right - textWidth(ctx, total, 14) - 8 - tagReserve - tx, 13);
  drawText(ctx, name, tx, l1, { size: 13, color: COLOR.ink });
  if (row.animated) drawGifTag(ctx, tag, tx + textWidth(ctx, name, 13) + 6, l1);
  drawSplitBar(ctx, row, tx, y + 33);
};
