/**
 * "Nobody used these" section: wrapping `name 0` chips for server emoji or
 * stickers with zero uses. Chip positions are measured up front so the
 * block reports its real height.
 */
import { roundRect } from '../canvas-primitives';
import { sectionTitle, type Block, type Ctx } from './layout';
import { drawText, fitText, textWidth } from './text';
import { COLOR, INNER_WIDTH, PAD } from './theme';
import type { UnusedSection } from './types-common';

const SIZE = 12;
const CHIP_HEIGHT = 22;
const ROW_STEP = 28;
const CHIP_GAP = 6;

interface PlacedChip {
  readonly name: string;
  readonly x: number;
  readonly row: number;
  readonly w: number;
}

const placeChips = (ctx: Ctx, section: UnusedSection): PlacedChip[] => {
  const zeroW = textWidth(ctx, section.zeroLabel, SIZE);
  const placed: PlacedChip[] = [];
  let x = PAD;
  let row = 0;
  for (const raw of section.names) {
    const name = fitText(ctx, raw, INNER_WIDTH - zeroW - 26, SIZE);
    const w = textWidth(ctx, name, SIZE) + 12 + zeroW + 14;
    if (x > PAD && x + w > PAD + INNER_WIDTH) {
      x = PAD;
      row += 1;
    }
    placed.push({ name, x, row, w });
    x += w + CHIP_GAP;
  }
  return placed;
};

/** Title with its caption, then the wrapped chips; nothing when `names` is empty. */
export const unusedBlocks = (measure: Ctx, section: UnusedSection): Block[] => {
  const chips = placeChips(measure, section);
  const rows = chips.length === 0 ? 0 : (chips[chips.length - 1]?.row ?? 0) + 1;
  const title = sectionTitle(section.title, { note: section.note });
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
          drawText(ctx, chip.name, chip.x + 8, mid, { size: SIZE, color: COLOR.body });
          const zeroStyle = { size: SIZE, color: COLOR.muted, align: 'right' } as const;
          drawText(ctx, section.zeroLabel, chip.x + chip.w - 8, mid, zeroStyle);
        }
      },
    },
  ];
};
