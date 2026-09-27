/**
 * Polished horizontal-bar ranking for /traffic: a faint full-width track
 * behind each rounded gradient bar, the channel / user name on the left,
 * and `value + percent` at the bar end. All text is passed in
 * pre-translated; percentages are relative to `total` (visible messages).
 */
import type { AttachmentBuilder } from 'discord.js';
import { canvasFont } from '../../../infra/graphics/canvas-font';

import {
  ACCENT,
  ACCENT_EDGE,
  FG,
  MUTED,
  TRACK,
  WIDTH,
  newCanvas,
  paintHeader,
  roundRect,
  stripEmoji,
  toAttachment,
  truncate,
  type ChartRow,
} from './chart-common';

const ROW_H = 30;
const TOP = 54;
const LABEL_W = 220;
const VALUE_W = 130;
const BAR_RADIUS = 6;
const MAX_LABEL_CHARS = 24;

export const renderRankingBarChart = (
  title: string,
  rows: readonly ChartRow[],
  total: number,
  fileName: string,
): AttachmentBuilder => {
  const height = TOP + Math.max(1, rows.length) * ROW_H + 14;
  const { canvas, ctx } = newCanvas(height);
  paintHeader(ctx, WIDTH, height, title);

  const barLeft = LABEL_W;
  const barMax = WIDTH - LABEL_W - VALUE_W;
  const max = Math.max(1, ...rows.map((r) => r.value));

  rows.forEach((row, i) => {
    const barH = ROW_H - 12;
    const barY = TOP + i * ROW_H + 4;
    const midY = barY + barH / 2;

    ctx.fillStyle = FG;
    ctx.font = canvasFont(14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(stripEmoji(row.label), MAX_LABEL_CHARS), 16, midY);

    ctx.fillStyle = TRACK;
    roundRect(ctx, barLeft, barY, barMax, barH, BAR_RADIUS);
    ctx.fill();

    const w = Math.max(barH, (barMax * row.value) / max);
    const gradient = ctx.createLinearGradient(barLeft, 0, barLeft + w, 0);
    gradient.addColorStop(0, ACCENT);
    gradient.addColorStop(1, ACCENT_EDGE);
    ctx.fillStyle = gradient;
    roundRect(ctx, barLeft, barY, w, barH, BAR_RADIUS);
    ctx.fill();

    const pct = total > 0 ? ((row.value / total) * 100).toFixed(1) : '0.0';
    ctx.fillStyle = MUTED;
    ctx.font = canvasFont(13);
    ctx.textAlign = 'left';
    ctx.fillText(`${row.value}  (${pct}%)`, barLeft + barMax + 10, midY);
  });

  return toAttachment(canvas, fileName);
};
