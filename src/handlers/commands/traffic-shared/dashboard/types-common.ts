/**
 * Building-block view-model types shared by every /traffic dashboard.
 * Every user-facing string arrives already translated; the renderer only
 * formats plain counts (digit grouping) and percentages itself.
 */
import type { Image } from 'canvas';

/**
 * A custom or Unicode emoji inside a line of text. `image` is a preloaded
 * picture (Discord CDN download) or `null`; when it is `null` or failed to
 * decode, `fallback` is drawn as text. The chart font has no colour emoji:
 * pass `:name:` for a custom emoji. A fallback made only of emoji
 * characters (a Unicode emoji's own `name`) is dropped rather than drawn
 * as tofu boxes.
 */
export interface EmojiToken {
  readonly image: Image | null;
  readonly fallback: string;
}

/** One run of text: plain strings interleaved with emoji tokens. */
export type InlinePart = string | EmojiToken;
export type RichText = string | readonly InlinePart[];

export interface Delta {
  /** `up` draws green with an up triangle, `down` red, `flat` muted without one. */
  readonly direction: 'up' | 'down' | 'flat';
  /** Percentage text next to the triangle, e.g. `8.2%`. */
  readonly text: string;
  /** Sub-line under the delta, e.g. "vs previous 11,410". */
  readonly sub: string;
}

export interface HeroMetric {
  readonly label: string;
  readonly value: string;
  /** Small suffix after the value, e.g. `/ 213`. */
  readonly unit?: string;
}

/** The headline tile: big value, optional period delta, secondary metrics. */
export interface HeroTile {
  readonly label: string;
  readonly value: string;
  readonly delta?: Delta;
  readonly metrics: readonly HeroMetric[];
}

export interface StatTile {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly sub?: RichText;
  /** Relative width inside its row (default 1; clamped to at least 0.25). */
  readonly flex?: number;
}

export interface TrendSection {
  readonly title: string;
  readonly currentLabel: string;
  readonly current: readonly number[];
  /** Gray previous-period line, aligned bucket-by-bucket with `current`. */
  readonly previous?: { readonly label: string; readonly values: readonly number[] };
  readonly xLabels: readonly string[];
  /**
   * Draw every n-th x label (the last one is always drawn). Auto when omitted;
   * labels are thinned further when they would not fit the chart width.
   */
  readonly xLabelEvery?: number;
}

/** Weekday x hour heatmap; a grid that is not 7 x 24 makes the renderer throw `RangeError`. */
export interface HeatmapSection {
  readonly title: string;
  /** Seven rows (in `weekdayLabels` order) of 24 hourly counts. */
  readonly grid: readonly (readonly number[])[];
  /** Seven short weekday names (e.g. `Mon`); longer ones are truncated to the label column. */
  readonly weekdayLabels: readonly string[];
  readonly lessLabel: string;
  /** Legend text after the ramp, given the formatted per-cell maximum. */
  readonly moreLabel: (max: string) => string;
  /** Right-aligned peak caption, given the peak row's label and the raw hour (0-23). */
  readonly peakLabel: (weekday: string, hour: number) => string;
}

export interface KeyValueRow {
  readonly label: RichText;
  readonly value: string;
  /** Indented, muted detail row under the previous one. */
  readonly secondary?: boolean;
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  /** Replaces the default formatted count at the bar tip. */
  readonly valueText?: string;
}

export interface RankRow {
  readonly name: string;
  /** Small chip after the name, e.g. the forum a post belongs to. */
  readonly tag?: string;
  readonly value: number;
  readonly segments?: never;
}

/** A ranked row whose bar is split into coloured segments (summed for the value). */
export interface SegmentedRankRow {
  readonly name: string;
  readonly tag?: string;
  /** At most three segments; the segment palette repeats after the third. */
  readonly segments: readonly number[];
  readonly value?: never;
}

/** Either kind of ranked row; the bar lists accept both. */
export type AnyRankRow = RankRow | SegmentedRankRow;

export interface RankingColumn<Row extends AnyRankRow = RankRow> {
  readonly title: string;
  /** Only the first `RANK_ROW_LIMIT` rows are drawn. */
  readonly rows: readonly Row[];
  /** Muted line under the list, e.g. "27 other channels, 2,611 messages". */
  readonly note?: string;
  /** Draw rank numbers (default true); off for non-ranking lists such as weekday averages. */
  readonly ranked?: boolean;
}

export interface TitledRows<Row> {
  readonly title: string;
  readonly rows: readonly Row[];
}

/** Server emoji or stickers nobody used, shown as their pictures. */
export interface UnusedSection {
  readonly title: string;
  /** Muted caption after the title, e.g. "7 in total". */
  readonly note: string;
  /** How many items nobody used; more than `items` adds a `…` chip. */
  readonly total: number;
  /** Nothing but the title is drawn when this is empty. */
  readonly items: readonly {
    /** Seeds the placeholder drawn when `image` is missing. */
    readonly label: string;
    readonly image: Image | null;
  }[];
}
