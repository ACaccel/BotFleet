/**
 * Polished line chart for the /traffic time series: a stroked line with a
 * gradient area fill, dashed y-gridlines with integer ticks + a unit label,
 * and sparse x time labels. All axis text is passed in pre-translated.
 */
import type { AttachmentBuilder } from 'discord.js';
import { canvasFont } from '../../../infra/graphics/canvas-font';

import {
  ACCENT_EDGE,
  GRID,
  MUTED,
  WIDTH,
  newCanvas,
  niceTicks,
  paintHeader,
  toAttachment,
  type ChartRow,
} from './chart-common';

const HEIGHT = 380;
const PLOT_TOP = 56;
const PLOT_BOTTOM = HEIGHT - 40;
const PLOT_LEFT = 64;
const PLOT_RIGHT = WIDTH - 24;
const MAX_X_LABELS = 12;

export const renderTimeSeriesChart = (
  title: string,
  yAxisLabel: string,
  points: readonly ChartRow[],
  fileName: string,
): AttachmentBuilder => {
  const { canvas, ctx } = newCanvas(HEIGHT);
  paintHeader(ctx, WIDTH, HEIGHT, title);

  const { niceMax, ticks } = niceTicks(Math.max(1, ...points.map((p) => p.value)));
  const plotW = PLOT_RIGHT - PLOT_LEFT;
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const yOf = (value: number): number => PLOT_BOTTOM - (plotH * value) / niceMax;
  const xOf = (i: number): number =>
    points.length <= 1 ? PLOT_LEFT + plotW / 2 : PLOT_LEFT + (plotW * i) / (points.length - 1);

  // Dashed y-gridlines + integer tick labels.
  ctx.font = canvasFont(12);
  ctx.textBaseline = 'middle';
  for (const tick of ticks) {
    const y = yOf(tick);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PLOT_LEFT, y);
    ctx.lineTo(PLOT_RIGHT, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(String(tick), PLOT_LEFT - 8, y);
  }

  // Y-axis unit label, above the plot.
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(yAxisLabel, 16, PLOT_TOP - 8);

  // Gradient area fill under the line.
  const gradient = ctx.createLinearGradient(0, PLOT_TOP, 0, PLOT_BOTTOM);
  gradient.addColorStop(0, 'rgba(124,136,255,0.42)');
  gradient.addColorStop(1, 'rgba(124,136,255,0.02)');
  ctx.beginPath();
  ctx.moveTo(xOf(0), PLOT_BOTTOM);
  points.forEach((p, i) => ctx.lineTo(xOf(i), yOf(p.value)));
  ctx.lineTo(xOf(points.length - 1), PLOT_BOTTOM);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // The line itself + point dots.
  ctx.beginPath();
  points.forEach((p, i) =>
    i === 0 ? ctx.moveTo(xOf(i), yOf(p.value)) : ctx.lineTo(xOf(i), yOf(p.value)),
  );
  ctx.strokeStyle = ACCENT_EDGE;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fillStyle = ACCENT_EDGE;
  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(xOf(i), yOf(p.value), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // X-axis baseline + sparse time labels.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PLOT_LEFT, PLOT_BOTTOM);
  ctx.lineTo(PLOT_RIGHT, PLOT_BOTTOM);
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.font = canvasFont(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const step = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));
  points.forEach((p, i) => {
    if (i % step === 0) ctx.fillText(p.label, xOf(i), PLOT_BOTTOM + 16);
  });

  return toAttachment(canvas, fileName);
};
