/**
 * Detail lists, each a titled block across its column: interaction
 * key-values and content-type bars.
 */
import { ROW_HEIGHT, drawBars } from './bars';
import { TITLE_HEIGHT, drawTitle, type Block, type Column, type Ctx } from './layout';
import { hline } from './shapes';
import { drawRich, drawText, textWidth } from './text';
import { COLOR } from './theme';
import type { BarRow, KeyValueRow, TitledRows } from './types-common';

const SECONDARY_INDENT = 18;
const VALUE_SIZE = 14;
const LABEL_SIZE = 13;
/** Content labels may take more of the column than ranked names do. */
const DETAIL_LABEL_SHARE = 0.6;

const drawKeyValues = (ctx: Ctx, col: Column, y: number, rows: readonly KeyValueRow[]): void => {
  const { x, w } = col;
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

/** Key-value rows with the value right-aligned; a secondary row is indented and muted. */
export const keyValueList = (section: TitledRows<KeyValueRow>, col: Column): Block => ({
  height: TITLE_HEIGHT + section.rows.length * ROW_HEIGHT,
  draw: (ctx, y) => {
    drawTitle(ctx, section.title, col.x, y, col.w);
    drawKeyValues(ctx, col, y + TITLE_HEIGHT, section.rows);
  },
});

/** Labelled bars, e.g. content types. */
export const barList = (section: TitledRows<BarRow>, col: Column): Block => ({
  height: TITLE_HEIGHT + section.rows.length * ROW_HEIGHT,
  draw: (ctx, y) => {
    drawTitle(ctx, section.title, col.x, y, col.w);
    drawBars(ctx, col.x, y + TITLE_HEIGHT, col.w, section.rows, {
      labelShare: DETAIL_LABEL_SHARE,
    });
  },
});
