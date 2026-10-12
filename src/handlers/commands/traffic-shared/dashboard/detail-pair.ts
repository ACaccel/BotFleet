/**
 * The detail pair: interaction key-values beside content-type bars, split
 * inside one column by what the key-values need.
 */
import { ROW_HEIGHT, drawBars } from './bars';
import { TITLE_HEIGHT, drawTitle, splitColumn, type Block, type Column, type Ctx } from './layout';
import { hline } from './shapes';
import { drawRich, drawText, richWidth, textWidth } from './text';
import { COLOR, COLUMN_GAP } from './theme';
import type { BarRow, KeyValueRow, TitledRows } from './types-common';

const SECONDARY_INDENT = 18;
const VALUE_SIZE = 14;
const LABEL_SIZE = 13;
/** The key-value half of a detail pair takes between these shares of the pair. */
const KEY_SHARE_MIN = 0.4;
const KEY_SHARE_MAX = 0.6;
/** Content labels may take more of their half than ranked names do. */
const DETAIL_LABEL_SHARE = 0.6;

const drawKeyValues = (ctx: Ctx, half: Column, y: number, rows: readonly KeyValueRow[]): void => {
  const { x, w } = half;
  rows.forEach((row, i) => {
    const cy = y + i * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (i > 0) hline(ctx, x, x + w, y + i * ROW_HEIGHT, COLOR.grid);
    const secondary = row.secondary === true;
    const style = { size: VALUE_SIZE, color: COLOR.ink, bold: !secondary, align: 'right' } as const;
    drawText(ctx, row.value, x + w, cy, style);
    const lx = x + (secondary ? SECONDARY_INDENT : 0);
    const maxW = x + w - textWidth(ctx, row.value, VALUE_SIZE) - 8 - lx;
    const labelStyle = { size: LABEL_SIZE, color: secondary ? COLOR.muted : COLOR.body };
    drawRich(ctx, row.label, lx, cy, labelStyle, maxW);
  });
};

/** Width the key-value rows need to show every label and value in full. */
const keyValueWidth = (ctx: Ctx, rows: readonly KeyValueRow[]): number =>
  Math.max(
    0,
    ...rows.map(
      (row) =>
        (row.secondary === true ? SECONDARY_INDENT : 0) +
        richWidth(ctx, row.label, LABEL_SIZE) +
        8 +
        textWidth(ctx, row.value, VALUE_SIZE),
    ),
  );

/**
 * Interaction key-values (left) beside content-type bars (right). The
 * split follows what the key-values need, within 40-60% of the pair.
 */
export const detailPair = (
  left: TitledRows<KeyValueRow>,
  right: TitledRows<BarRow>,
  col: Column,
): Block => {
  const rows = Math.max(left.rows.length, right.rows.length);
  return {
    height: TITLE_HEIGHT + rows * ROW_HEIGHT,
    draw: (ctx, y) => {
      const avail = col.w - COLUMN_GAP;
      const need = keyValueWidth(ctx, left.rows);
      const leftW = Math.min(avail * KEY_SHARE_MAX, Math.max(avail * KEY_SHARE_MIN, need));
      const [keys, bars] = splitColumn(col, leftW);
      drawTitle(ctx, left.title, keys.x, y, keys.w);
      drawTitle(ctx, right.title, bars.x, y, bars.w);
      drawKeyValues(ctx, keys, y + TITLE_HEIGHT, left.rows);
      drawBars(ctx, bars.x, y + TITLE_HEIGHT, bars.w, right.rows, {
        labelShare: DETAIL_LABEL_SHARE,
      });
    },
  };
};
