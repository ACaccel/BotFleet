/**
 * Ordering shared by `/traffic emoji` and `/traffic sticker`. The statistics
 * reader returns usage in input order; the commands rank it: used items by count
 * (`most` or `least` first, ties by name), and the items nobody used listed
 * separately so `least` still finds them.
 */
import { formatCount, type StatTile } from './dashboard';
import type { TFn } from './types';

export type UsageOrder = 'most' | 'least';
export const USAGE_ORDERS: readonly UsageOrder[] = ['most', 'least'];

/** Pictures beyond this are summarised by the section's `…` chip and total. */
export const UNUSED_ART_LIMIT = 40;

export interface Ranked<T> {
  readonly used: readonly T[];
  readonly unused: readonly T[];
}

export const rankUsage = <T>(
  items: readonly T[],
  total: (item: T) => number,
  name: (item: T) => string,
  order: UsageOrder,
): Ranked<T> => {
  const direction = order === 'most' ? -1 : 1;
  const byName = (a: T, b: T): number => name(a).localeCompare(name(b));
  return {
    used: items
      .filter((item) => total(item) > 0)
      .sort((a, b) => direction * (total(a) - total(b)) || byName(a, b)),
    unused: items.filter((item) => total(item) === 0).sort(byName),
  };
};

/** A count tile whose unit follows the count's plural form; an empty unit is omitted. */
export const countTile = (t: TFn, label: string, unitKey: string, count: number): StatTile => {
  const unit = t(unitKey, { count });
  return { label, value: formatCount(count), ...(unit.length > 0 ? { unit } : {}) };
};
