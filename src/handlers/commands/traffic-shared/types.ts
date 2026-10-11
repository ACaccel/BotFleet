/**
 * Types shared by every `/traffic` subcommand. Subcommand-specific shapes stay
 * next to the subcommand's report builder.
 */
export type Visibility = 'ephemeral' | 'public';
export type TrafficRange = '24h' | '7d' | '30d' | '90d' | '365d';

/** Translator function compatible with `bot.translator.t`. */
export type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Parsed and clamped `visibility` / `range` / `top_n` options. */
export interface TrafficOptions {
  readonly visibility: Visibility;
  readonly range: TrafficRange;
  readonly topN: number;
}
