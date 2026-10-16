/**
 * The guild-events plugin's `guild_events` config block.
 *
 * Also guards the shipped example configs against the schema: the
 * factory parses its block at construction time, so an example that
 * does not satisfy the schema would crash the personality at boot for
 * anyone who seeds `config.json` from it (which is exactly what CI
 * does, and what the setup instructions tell a human to do).
 */
import { describe, expect, it } from 'vitest';

import nijikaExample from '../../../src/bot/nijika/config.example.json';
import tomoriExample from '../../../src/bot/tomori/config.example.json';
import { parseGuildEventsConfig } from '../../../src/plugins/guild-events/config';

describe('parseGuildEventsConfig', () => {
  it('defaults an absent block to an enabled cache with a 24-hour TTL and a 5 GiB floor', () => {
    expect(parseGuildEventsConfig(undefined)).toEqual({
      attachment_cache: { enabled: true, ttlHours: 24, minFreeDiskMb: 5120 },
    });
  });

  it('defaults a partial block field by field', () => {
    expect(parseGuildEventsConfig({ attachment_cache: { ttlHours: 6 } })).toEqual({
      attachment_cache: { enabled: true, ttlHours: 6, minFreeDiskMb: 5120 },
    });
  });

  it('accepts a custom free-space floor', () => {
    expect(parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: 512 } })).toEqual({
      attachment_cache: { enabled: true, ttlHours: 24, minFreeDiskMb: 512 },
    });
  });

  it('rejects a free-space floor that is not a positive whole number of MiB', () => {
    // `0` reads as "no floor" but would mean caching right up to a full
    // disk, which is the failure the field exists to prevent; the rest
    // are typos that must fail the boot rather than be coerced.
    expect(() => parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: 0 } })).toThrow();
    expect(() => parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: -1 } })).toThrow();
    expect(() => parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: 1.5 } })).toThrow();
    expect(() =>
      parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: Infinity } }),
    ).toThrow();
    expect(() => parseGuildEventsConfig({ attachment_cache: { minFreeDiskMb: '512' } })).toThrow();
  });

  it('rejects an unknown key, so a typo fails the boot instead of being ignored', () => {
    expect(() => parseGuildEventsConfig({ attachment_cache: { ttl_hour: 6 } })).toThrow();
    expect(() => parseGuildEventsConfig({ attachement_cache: {} })).toThrow();
  });

  it('rejects a non-positive TTL, which would sweep every entry immediately', () => {
    expect(() => parseGuildEventsConfig({ attachment_cache: { ttlHours: 0 } })).toThrow();
    expect(() => parseGuildEventsConfig({ attachment_cache: { ttlHours: -1 } })).toThrow();
  });

  it('rejects a TTL beyond a year, so a typo cannot become permanent retention', () => {
    // `ttlHours` is the privacy control for a copy of every recent
    // attachment; an unbounded value has to fail the boot, not pass.
    expect(() => parseGuildEventsConfig({ attachment_cache: { ttlHours: 1000000 } })).toThrow();
    expect(() => parseGuildEventsConfig({ attachment_cache: { ttlHours: Infinity } })).toThrow();
  });

  it('rejects a mistyped enabled flag rather than coercing it', () => {
    expect(() => parseGuildEventsConfig({ attachment_cache: { enabled: 'yes' } })).toThrow();
  });
});

describe.each([
  ['nijika', nijikaExample],
  ['tomori', tomoriExample],
])('%s config.example.json — guild_events block', (_name, example) => {
  const block = (example as Record<string, unknown>)['guild_events'];

  it('is present, so operators have something to copy', () => {
    expect(block).toBeDefined();
  });

  it('satisfies the plugin schema, so seeding config.json from it boots', () => {
    expect(() => parseGuildEventsConfig(block)).not.toThrow();
  });

  it('documents the shipped defaults rather than a variant of them', () => {
    expect(parseGuildEventsConfig(block)).toEqual(parseGuildEventsConfig(undefined));
  });
});
