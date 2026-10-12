/**
 * "Nobody used these" section: wrapping `name 0` chips for server emoji or
 * stickers with zero uses. Chip positions are measured up front so the
 * block reports its real height. Chips beyond the row cap are replaced by
 * one `…` chip; the section's caption still states the full count.
 */
import { roundRect } from '../canvas-primitives';
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { drawText, fitText, textWidth } from './text';
import { COLOR } from './theme';
import type { UnusedSection } from './types-common';

const SIZE = 12;
const CHIP_HEIGHT = 22;
const ROW_STEP = 28;
const CHIP_GAP = 6;
const MORE = '…';

interface PlacedChip {
  /** `undefined` for the trailing "more" chip. */
  readonly name: string | undefined;
  readonly x: number;
  readonly row: number;
  readonly w: number;
}

/** Wrap `widths` into rows of the column; returns each chip's row and x. */
const flow = (widths: readonly number[], col: Column): { x: number; row: number }[] => {
  let x = col.x;
  let row = 0;
  return widths.map((w) => {
    if (x > col.x && x + w > col.x + col.w) {
      x = col.x;
      row += 1;
    }
    const at = { x, row };
    x += w + CHIP_GAP;
    return at;
  });
};

const placeChips = (
  ctx: Ctx,
  section: UnusedSection,
  col: Column,
  maxRows: number,
): PlacedChip[] => {
  const zeroW = textWidth(ctx, section.zeroLabel, SIZE);
  const names = section.names.map((raw) => fitText(ctx, raw, col.w - zeroW - 26, SIZE));
  const widths = names.map((name) => textWidth(ctx, name, SIZE) + 12 + zeroW + 14);
  const all = flow(widths, col);
  const place = (count: number, more: boolean): PlacedChip[] => {
    const shown = widths.slice(0, count);
    const moreW = textWidth(ctx, MORE, SIZE) + 16;
    const spots = flow(more ? [...shown, moreW] : shown, col);
    return spots.map((spot, i) => ({
      name: i < count ? names[i] : undefined,
      x: spot.x,
      row: spot.row,
      w: i < count ? (widths[i] ?? 0) : moreW,
    }));
  };
  if ((all[all.length - 1]?.row ?? 0) < maxRows) return place(names.length, false);
  let count = all.filter((spot) => spot.row < maxRows).length;
  while (count > 0 && (place(count, true).at(-1)?.row ?? 0) >= maxRows) count -= 1;
  return place(count, true);
};

/**
 * Title with its caption, then the wrapped chips (at most `maxRows` rows);
 * nothing but the title when `names` is empty.
 */
export const unusedBlocks = (
  measure: Ctx,
  section: UnusedSection,
  col: Column,
  maxRows: number,
): Block[] => {
  const chips = placeChips(measure, section, col, Math.max(1, maxRows));
  const rows = chips.length === 0 ? 0 : (chips[chips.length - 1]?.row ?? 0) + 1;
  const title = sectionTitle(measure, col, section.title, { note: section.note });
  if (rows === 0) return [title];
  return [
    title,
    {
      height: (rows - 1) * ROW_STEP + CHIP_HEIGHT,
      draw: (ctx, y) => {
        for (const chip of chips) {
          const cy = y + chip.row * ROW_STEP;
          roundRect(ctx, chip.x, cy, chip.w, CHIP_HEIGHT, 6);
          ctx.fillStyle = COLOR.tile;
          ctx.fill();
          const mid = cy + CHIP_HEIGHT / 2 + 0.5;
          if (chip.name === undefined) {
            const style = { size: SIZE, color: COLOR.muted, align: 'center' } as const;
            drawText(ctx, MORE, chip.x + chip.w / 2, mid, style);
            continue;
          }
          drawText(ctx, chip.name, chip.x + 8, mid, { size: SIZE, color: COLOR.body });
          const zeroStyle = { size: SIZE, color: COLOR.muted, align: 'right' } as const;
          drawText(ctx, section.zeroLabel, chip.x + chip.w - 8, mid, zeroStyle);
        }
      },
    },
  ];
};
