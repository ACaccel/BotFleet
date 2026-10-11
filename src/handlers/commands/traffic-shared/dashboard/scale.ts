/**
 * Axis and series maths for the dashboard trend chart.
 */
const MAX_INTERVALS = 3;
/** Candidate tick steps in ascending order; 2.5 is skipped below 10 to keep ticks integral. */
const STEPS: readonly number[] = Array.from({ length: 13 }, (_, e) =>
  (e === 0 ? [1, 2, 5] : [1, 2, 2.5, 5]).map((m) => m * 10 ** e),
).flat();

/** Smallest 1 / 2 / 2.5 / 5 x 10^k integer step covering `max` in `maxIntervals` steps. */
export const dashboardTicks = (
  max: number,
  maxIntervals = MAX_INTERVALS,
): { readonly niceMax: number; readonly ticks: readonly number[] } => {
  const top = Number.isFinite(max) && max > 0 ? max : 1;
  const step =
    STEPS.find((s) => Math.ceil(top / s) <= maxIntervals) ?? STEPS[STEPS.length - 1] ?? 1;
  const niceMax = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return { niceMax, ticks };
};

/** Indices of the largest and smallest non-zero values (-1 when all are zero). */
export const extremes = (values: readonly number[]): { hi: number; lo: number } => {
  let hi = -1;
  let lo = -1;
  values.forEach((v, i) => {
    if (v > 0 && (hi < 0 || v > (values[hi] ?? 0))) hi = i;
    if (v > 0 && (lo < 0 || v < (values[lo] ?? 0))) lo = i;
  });
  return { hi, lo };
};
