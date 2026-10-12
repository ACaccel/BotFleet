/**
 * Server-sticker dashboard in two columns: the summary tiles
 * above the chips of stickers nobody used, beside a grid of ranked sticker
 * cards (art, name, count with share, usage bar relative to the top
 * sticker).
 */
import { roundRect } from '../canvas-primitives';
import { drawArt } from './art';
import { unusedBlocks } from './chips';
import { renderColumns } from './columns';
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { COLOR, formatCount, formatPercent } from './theme';
import { tileRows } from './tiles';
import type { StickerDashboard, StickerRanking, StickerRankRow } from './types';

const COLUMNS = 4;
/** Three rows of four cards. */
export const STICKER_RANK_LIMIT = COLUMNS * 3;

const GAP = 8;
const CARD_WIDTH = 116;
const CARD_HEIGHT = 138;
/** The image is wider than 4:3, so narrow columns enlarge the displayed text. */
const SUMMARY_WIDTH = 200;
const GRID_WIDTH = COLUMNS * CARD_WIDTH + GAP * (COLUMNS - 1);
/** Chip rows that keep the summary column no taller than a full grid. */
const UNUSED_ROWS = 10;
const ART_SIZE = 70;
const NOTE_HEIGHT = 22;

interface CardContext {
  readonly caption: StickerRanking['countCaption'];
  readonly totalUses: number;
  readonly max: number;
}

const drawCard = (
  ctx: Ctx,
  row: StickerRankRow,
  rank: number,
  card: CardContext,
  x: number,
  y: number,
): void => {
  roundRect(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 8);
  ctx.fillStyle = COLOR.tile;
  ctx.fill();
  const initials = Array.from(row.name).slice(0, 1).join('');
  drawArt(
    ctx,
    { image: row.image, name: row.name, initials },
    x + (CARD_WIDTH - ART_SIZE) / 2,
    y + 12,
    ART_SIZE,
    12,
  );
  ctx.beginPath();
  ctx.arc(x + 13, y + 13, 9, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.embedBg;
  ctx.fill();
  drawText(ctx, String(rank), x + 13, y + 13.5, { size: 12, color: COLOR.body, align: 'center' });
  const center = { size: 13, color: COLOR.ink, align: 'center' } as const;
  drawFitted(ctx, row.name, x + CARD_WIDTH / 2, y + 98, CARD_WIDTH - 12, center);
  const count = formatCount(row.count);
  const countW = textWidth(ctx, count, 14);
  const caption = card.caption(row.count, formatPercent(row.count, card.totalUses));
  const suffix = fitText(ctx, ` ${caption}`, CARD_WIDTH - 12 - countW, 11);
  const sx = x + (CARD_WIDTH - countW - textWidth(ctx, suffix, 11)) / 2;
  drawText(ctx, count, sx, y + 116, { size: 14, color: COLOR.ink, bold: true });
  drawText(ctx, suffix, sx + countW, y + 117, { size: 11, color: COLOR.muted });
  const track = CARD_WIDTH - 24;
  roundRect(ctx, x + 12, y + 127, track, 4, 2);
  ctx.fillStyle = COLOR.grid;
  ctx.fill();
  roundRect(ctx, x + 12, y + 127, Math.max((track * row.count) / card.max, 3), 4, 2);
  ctx.fillStyle = COLOR.current;
  ctx.fill();
};

const rankingBlocks = (measure: Ctx, ranking: StickerRanking, col: Column): Block[] => {
  const rows = ranking.rows.slice(0, STICKER_RANK_LIMIT);
  const gridRows = Math.ceil(rows.length / COLUMNS);
  const gridH = gridRows === 0 ? 0 : gridRows * (CARD_HEIGHT + GAP) - GAP;
  const noteH = ranking.note === undefined ? 0 : NOTE_HEIGHT;
  const card: CardContext = {
    caption: ranking.countCaption,
    totalUses: ranking.totalUses,
    max: Math.max(1, ...rows.map((r) => r.count)),
  };
  return [
    sectionTitle(measure, col, ranking.title),
    {
      height: gridH + noteH,
      draw: (ctx, y) => {
        rows.forEach((row, i) => {
          const cx = col.x + (i % COLUMNS) * (CARD_WIDTH + GAP);
          const cy = y + Math.floor(i / COLUMNS) * (CARD_HEIGHT + GAP);
          drawCard(ctx, row, i + 1, card, cx, cy);
        });
        if (ranking.note === undefined) return;
        drawText(ctx, ranking.note, col.x, y + gridH + 15, { size: 12, color: COLOR.muted });
      },
    },
  ];
};

export const renderStickerDashboard = (data: StickerDashboard): Buffer =>
  renderColumns([
    {
      width: SUMMARY_WIDTH,
      sections: (col, measure) => [
        data.tiles.length > 0 ? tileRows(data.tiles, col) : undefined,
        data.unused === undefined
          ? undefined
          : unusedBlocks(measure, data.unused, col, UNUSED_ROWS),
      ],
    },
    { width: GRID_WIDTH, sections: (col, measure) => [rankingBlocks(measure, data.ranking, col)] },
  ]);
