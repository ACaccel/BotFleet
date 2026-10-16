/**
 * The `visibility` / `range` / `top_n` options the `/traffic` subcommands
 * share: their declaration and their parsing. Each subcommand picks its range
 * and visibility defaults and its row count, which is the most rows its
 * dashboard draws; only subcommands with long rankings let members lower it
 * through `top_n`. Subcommand-specific options are declared and read by the
 * subcommand.
 *
 * `visibility` sets both the reply audience and the channel-rank ceiling of the
 * visibility filter: `public` is capped by the invoker's clearance AND the
 * command channel's rank, `ephemeral` by the invoker's clearance alone. Discord
 * enforces the choice and bound limits; the parsing here is a defence against
 * direct API calls that bypass them.
 */
import type { ChatInputCommandInteraction } from 'discord.js';

import type { CommandConfig } from '../command';

import type { TrafficOptions, TrafficRange, Visibility } from './types';

const VISIBILITIES: readonly Visibility[] = ['ephemeral', 'public'];
const RANGES: readonly TrafficRange[] = ['24h', '7d', '30d', '90d', '365d'];

export interface TrafficOptionSpec {
  readonly defaultRange: TrafficRange;
  /** Who sees the reply when `visibility` is omitted; `public` by default. */
  readonly defaultVisibility?: Visibility;
  /** Largest and default row count: the most rows the subcommand's dashboard draws. */
  readonly maxTopN: number;
  /** Offer `top_n` so members can show fewer rows; only worth it for long rankings. */
  readonly adjustableTopN?: boolean;
}

type Options = NonNullable<CommandConfig['options']>;

/** The shared option declarations merged with the subcommand's own. */
export const trafficCommandOptions = (spec: TrafficOptionSpec, extra: Options = {}): Options => ({
  ...extra,
  string: [
    ...(extra.string ?? []),
    {
      name: 'range',
      required: false,
      choices: RANGES.map((value) => ({ value })),
    },
    {
      name: 'visibility',
      required: false,
      choices: VISIBILITIES.map((value) => ({ value })),
    },
  ],
  ...(spec.adjustableTopN === true
    ? {
        integer: [
          ...(extra.integer ?? []),
          { name: 'top_n', required: false, min: 1, max: spec.maxTopN },
        ],
      }
    : {}),
});

const isOneOf = <T extends string>(raw: unknown, values: readonly T[]): raw is T =>
  values.some((value) => value === raw);

const pick = <T extends string>(raw: unknown, values: readonly T[], fallback: T): T =>
  isOneOf(raw, values) ? raw : fallback;

export const readTrafficOptions = (
  interaction: Pick<ChatInputCommandInteraction, 'options'>,
  spec: TrafficOptionSpec,
): TrafficOptions => {
  const rawTopN = spec.adjustableTopN === true ? interaction.options.get('top_n')?.value : null;
  const topN =
    typeof rawTopN === 'number' && Number.isFinite(rawTopN)
      ? Math.min(spec.maxTopN, Math.max(1, Math.floor(rawTopN)))
      : spec.maxTopN;
  return {
    visibility: pick(
      interaction.options.get('visibility')?.value,
      VISIBILITIES,
      spec.defaultVisibility ?? 'public',
    ),
    range: pick(interaction.options.get('range')?.value, RANGES, spec.defaultRange),
    topN,
  };
};

/** A string choice option of the subcommand, or `fallback` when absent or unknown. */
export const readChoice = <T extends string>(
  interaction: Pick<ChatInputCommandInteraction, 'options'>,
  name: string,
  values: readonly T[],
  fallback: T,
): T => pick(interaction.options.get(name)?.value, values, fallback);
