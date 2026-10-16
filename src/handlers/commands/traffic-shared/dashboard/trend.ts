/**
 * Period trend: the current series as a blue line over a light area wash,
 * the previous period as a gray line, hairline gridlines, and direct
 * labels on the peak and the quietest non-zero bucket. X labels are
 * thinned until they fit the column without overlapping.
 */
import { sectionTitle, type Block, type Column, type Ctx } from './layout';
import { hline } from './shapes';
import { drawText, textWidth } from './text';
import { COLOR, formatCount, withAlpha } from './theme';
import { dashboardTicks, extremes } from './scale';
import type { TrendSection } from './types-common';

const TICK_SIZE = 12;
const LABEL_SIZE = 13;
const DENSE_POINTS = 8;
/** Least room between two x labels; narrower columns draw fewer labels. */
const LABEL_GAP = 10;

const strokeSeries = (
  ctx: Ctx,
  values: readonly number[],
  point: (i: number, v: number) => readonly [number, number],
  color: string,
): void => {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  values.forEach((v, i) => {
    const [px, py] = point(i, v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
};

const drawChart = (ctx: Ctx, trend: TrendSection, col: Column, y: number, h: number): void => {
  const { x, w } = col;
  const cur = trend.current;
  const n = cur.length;
  const prev = (trend.previous?.values ?? []).slice(0, n);
  const { niceMax, ticks } = dashboardTicks(Math.max(0, ...cur, ...prev));
  const tickW = Math.max(...ticks.map((t) => textWidth(ctx, formatCount(t), TICK_SIZE)));
  const left = x + tickW + 8;
  const right = x + w - 4;
  const bottom = y + h - 20;
  const plotTop = y + 18;
  const inset = n <= DENSE_POINTS ? 14 : 6;
  const xOf = (i: number): number =>
    n <= 1 ? (left + right) / 2 : left + inset + (i * (right - left - 2 * inset)) / (n - 1);
  const yOf = (v: number): number => bottom - (v / niceMax) * (bottom - plotTop);
  const point = (i: number, v: number): readonly [number, number] => [xOf(i), yOf(v)];

  for (const t of ticks) {
    hline(ctx, left, right, yOf(t), t === 0 ? COLOR.base : COLOR.grid);
    const style = { size: TICK_SIZE, color: COLOR.muted, align: 'right' } as const;
    drawText(ctx, formatCount(t), left - 8, yOf(t), style);
  }
  if (n === 0) return;

  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  cur.forEach((v, i) => ctx.lineTo(xOf(i), yOf(v)));
  ctx.lineTo(xOf(n - 1), yOf(0));
  ctx.closePath();
  ctx.fillStyle = withAlpha(COLOR.current, 0.14);
  ctx.fill();
  if (prev.length > 1) strokeSeries(ctx, prev, point, COLOR.previous);
  strokeSeries(ctx, cur, point, COLOR.current);

  const { hi, lo } = extremes(cur);
  const dots = n <= DENSE_POINTS ? cur.map((_, i) => i) : [hi, lo].filter((i) => i >= 0);
  for (const i of dots) {
    const [px, py] = point(i, cur[i] ?? 0);
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.embedBg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.current;
    ctx.fill();
  }
  const annotate = (i: number, below: boolean): void => {
    const [px, py] = point(i, cur[i] ?? 0);
    const align = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
    const ax = align === 'left' ? px - 6 : align === 'right' ? px + 6 : px;
    const style = { size: LABEL_SIZE, color: COLOR.ink, bold: true, align } as const;
    drawText(ctx, formatCount(cur[i] ?? 0), ax, below ? py + 16 : py - 15, style);
  };
  if (hi >= 0) annotate(hi, false);
  if (lo >= 0 && lo !== hi) annotate(lo, true);

  const shown = trend.xLabels.slice(0, n);
  const labelW = Math.max(0, ...shown.map((label) => textWidth(ctx, label, TICK_SIZE)));
  const fitting = Math.max(1, Math.floor((right - left) / (labelW + LABEL_GAP)));
  const preferred = trend.xLabelEvery ?? (n <= DENSE_POINTS ? 1 : Math.ceil((n - 1) / 4));
  const every = Math.max(1, preferred, Math.ceil(n / fitting));
  shown.forEach((label, i) => {
    const last = i === n - 1;
    if (!last && (i % every !== 0 || n - 1 - i < every * 0.6)) return;
    const half = textWidth(ctx, label, TICK_SIZE) / 2;
    const lx = Math.min(Math.max(xOf(i), x + half), x + w - half);
    const style = { size: TICK_SIZE, color: COLOR.muted, align: 'center' } as const;
    drawText(ctx, label, lx, bottom + 12, style);
  });
};

/** Default chart height under the title, in logical pixels. */
export const TREND_CHART_HEIGHT = 112;

/**
 * Section title with the current / previous legend, followed by the chart.
 * The legend wraps under the title when the column is too narrow for both.
 */
export const trendBlocks = (
  measure: Ctx,
  trend: TrendSection,
  col: Column,
  chartHeight = TREND_CHART_HEIGHT,
): Block[] => [
  sectionTitle(measure, col, trend.title, {
    legend: [
      { name: trend.currentLabel, color: COLOR.current, kind: 'line' },
      ...(trend.previous === undefined
        ? []
        : [{ name: trend.previous.label, color: COLOR.previous, kind: 'line' as const }]),
    ],
  }),
  { height: chartHeight, draw: (ctx, y) => drawChart(ctx, trend, col, y, chartHeight) },
];
