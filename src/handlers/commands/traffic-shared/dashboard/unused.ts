/**
 * "Nobody used these" section for server emoji or stickers: their pictures in
 * rows, or a coloured placeholder when a picture is missing. Items beyond the
 * row cap, or beyond those given, are replaced by one `…` chip; the section's
 * caption still states the full count.
 */
import { roundRect } from '../canvas-primitives';
import { drawArt, initialsOf } from './art';
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { drawText } from './text';
import { COLOR } from './theme';
import type { UnusedSection } from './types-common';

const MORE = '…';
const MORE_SIZE = 12;
const GAP = 8;

/**
 * Title with its caption, then the pictures, `size` pixels square, in rows of
 * the column: at most `maxRows` rows, the last slot a `…` chip when some are
 * not drawn. Nothing but the title when `items` is empty.
 */
export const unusedBlocks = (
  measure: Ctx,
  section: UnusedSection,
  col: Column,
  maxRows: number,
  size: number,
): Block[] => {
  const step = size + GAP;
  const title = sectionTitle(measure, col, section.title, { note: section.note });
  if (section.items.length === 0) return [title];
  const perRow = Math.max(1, Math.floor((col.w + GAP) / step));
  const slots = perRow * Math.max(1, maxRows);
  const more = section.items.length > slots || section.total > section.items.length;
  const shown = more ? section.items.slice(0, slots - 1) : section.items;
  const rows = Math.ceil((shown.length + (more ? 1 : 0)) / perRow);
  return [
    title,
    {
      height: (rows - 1) * step + size,
      draw: (ctx, y) => {
        const at = (i: number) => ({
          x: col.x + (i % perRow) * step,
          y: y + Math.floor(i / perRow) * step,
        });
        shown.forEach((item, i) => {
          const { x, y: iy } = at(i);
          const art = { image: item.image, name: item.label, initials: initialsOf(item.label, 1) };
          drawArt(ctx, art, x, iy, size, 6);
        });
        if (!more) return;
        const { x, y: iy } = at(shown.length);
        roundRect(ctx, x, iy, size, size, 6);
        ctx.fillStyle = COLOR.tile;
        ctx.fill();
        const style = { size: MORE_SIZE, color: COLOR.muted, align: 'center' } as const;
        drawText(ctx, MORE, x + size / 2, iy + size / 2 + 0.5, style);
      },
    },
  ];
};
