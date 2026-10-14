/**
 * Guards the shipped example configs against the plugin's own schema.
 *
 * The plugin parses its block at construction time regardless of
 * `enabled`, so an example that does not satisfy the schema is not a
 * documentation nit — an operator who seeds `config.json` from
 * `config.example.json` (which is exactly what CI does, and what the
 * setup instructions tell a human to do) would crash the bot at boot.
 *
 * Every personality that registers the social-feed plugin ships such an
 * example, so the checks run over each of them: an example that drifts
 * from the schema breaks the same way whichever bot owns it.
 */
import { describe, expect, it } from 'vitest';

import nijikaExample from '../../../../src/bot/nijika/config.example.json';
import { parseSocialFeedConfig } from '../../../../src/plugins/social-feed/config';
import { parseFeedPlatformsConfig } from '../../../../src/infra/social-feed';

/** The `/feed` commands do not reach Discord unless they are deployed. */
const FEED_COMMANDS = ['feed'];

const examples: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['nijika', nijikaExample as Record<string, unknown>],
];

describe.each(examples)('%s config.example.json — social_feed block', (_name, example) => {
  const block = example['social_feed'];

  it('is present, so operators have something to copy', () => {
    expect(block).toBeDefined();
  });

  it('satisfies the plugin schema, so seeding config.json from it boots', () => {
    expect(() => parseSocialFeedConfig(block)).not.toThrow();
  });

  it('ships disabled, so copying it never starts polling by accident', () => {
    expect(parseSocialFeedConfig(block).enabled).toBe(false);
  });

  it('configures at least one platform, so enabling it is a one-word edit', () => {
    // An example whose `platforms` block is empty documents a
    // configuration that throws the moment `enabled` is flipped.
    expect(parseSocialFeedConfig(block).platforms.x).toBeDefined();
  });

  it('parses through the composition root’s platform parser too', () => {
    // The composition root reads the same block with a different
    // schema; an example that satisfies only one of the two would fail
    // at boot before the plugin ever saw it.
    expect(() => parseFeedPlatformsConfig(block)).not.toThrow();
  });

  it('lists the feed commands, so the example deploys a usable feature', () => {
    // The plugin polls, but nothing can be subscribed until the command
    // group is registered — an example that ships the block without
    // it documents a feed no one can fill.
    expect(example['commands']).toEqual(expect.arrayContaining(FEED_COMMANDS));
  });
});
