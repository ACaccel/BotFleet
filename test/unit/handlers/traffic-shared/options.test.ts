/**
 * Unit coverage for the options every `/traffic` subcommand shares: the
 * declarations (range choices, the subcommand's `top_n` ceiling) and the
 * parsing (defaults per subcommand, unknown values, `top_n` clamping).
 */
import { describe, expect, it } from 'vitest';

import {
  readChoice,
  readTrafficOptions,
  trafficCommandOptions,
} from '../../../../src/handlers/commands/traffic-shared/options';
import { buildChatInputInteraction } from '../../../fixtures/discord/interaction-builder';

const interactionWith = (values: Record<string, string | number>) =>
  buildChatInputInteraction({ options: values });

const ACTIVITY = { defaultRange: '7d', maxTopN: 10 } as const;
const EMOJI = { defaultRange: '30d', maxTopN: 20, adjustableTopN: true } as const;
const RANKED = { defaultRange: '7d', maxTopN: 10, adjustableTopN: true } as const;

describe('trafficCommandOptions', () => {
  it('declares every range, both audiences and the subcommand top_n ceiling', () => {
    const options = trafficCommandOptions(EMOJI, {
      string: [{ name: 'order', required: false }],
    });
    expect(options.string?.map((o) => o.name)).toEqual(['order', 'range', 'visibility']);
    expect(options.string?.[1]?.choices?.map((c) => c.value)).toEqual([
      '24h',
      '7d',
      '30d',
      '90d',
      '365d',
    ]);
    expect(options.integer).toEqual([{ name: 'top_n', required: false, min: 1, max: 20 }]);
  });

  it('omits top_n when the subcommand always draws its full ranking', () => {
    expect(trafficCommandOptions(ACTIVITY).integer).toBeUndefined();
  });
});

describe('readTrafficOptions', () => {
  it('applies the subcommand defaults when nothing is supplied', () => {
    expect(readTrafficOptions(interactionWith({}), ACTIVITY)).toEqual({
      visibility: 'public',
      range: '7d',
      topN: 10,
    });
    expect(readTrafficOptions(interactionWith({}), EMOJI).range).toBe('30d');
  });

  it('passes valid values through and falls back on unknown ones', () => {
    expect(
      readTrafficOptions(interactionWith({ visibility: 'ephemeral', range: '365d' }), ACTIVITY),
    ).toMatchObject({ visibility: 'ephemeral', range: '365d' });
    expect(
      readTrafficOptions(interactionWith({ visibility: 'loud', range: '2y' }), ACTIVITY),
    ).toMatchObject({ visibility: 'public', range: '7d' });
  });

  it.each([
    [0, 1],
    [-4, 1],
    [3.9, 3],
    [25, 10],
    [Number.NaN, 10],
  ])('clamps top_n %p to %p', (raw, expected) => {
    expect(readTrafficOptions(interactionWith({ top_n: raw }), RANKED).topN).toBe(expected);
  });

  it('ignores top_n on a subcommand that does not offer it', () => {
    expect(readTrafficOptions(interactionWith({ top_n: 3 }), ACTIVITY).topN).toBe(10);
  });

  it("uses the subcommand's default audience", () => {
    const privateByDefault = { ...ACTIVITY, defaultVisibility: 'ephemeral' } as const;
    expect(readTrafficOptions(interactionWith({}), privateByDefault).visibility).toBe('ephemeral');
    expect(
      readTrafficOptions(interactionWith({ visibility: 'public' }), privateByDefault).visibility,
    ).toBe('public');
  });
});

describe('readChoice', () => {
  it('reads a known choice and falls back otherwise', () => {
    const values = ['most', 'least'] as const;
    expect(readChoice(interactionWith({ order: 'least' }), 'order', values, 'most')).toBe('least');
    expect(readChoice(interactionWith({ order: 'random' }), 'order', values, 'most')).toBe('most');
    expect(readChoice(interactionWith({}), 'order', values, 'most')).toBe('most');
  });
});
