/**
 * Unit tests for {@link FeedPlatformRegistry}.
 *
 * Driven entirely by the fake platform: the registry must hold a
 * platform whose id is outside `SUPPORTED_FEED_PLATFORMS`, which is the
 * property that keeps the framework open to a source the union does not
 * yet name.
 */
import { describe, expect, it } from 'vitest';

import { FeedPlatformRegistry } from '../../../../src/infra/social-feed';
import { buildFakeFeedPlatform } from '../../../fixtures/social-feed/fake-platform';

describe('FeedPlatformRegistry', () => {
  it('returns a registered platform by id', () => {
    const { platform } = buildFakeFeedPlatform({ id: 'fake' });
    const registry = new FeedPlatformRegistry([platform]);

    expect(registry.get('fake')).toBe(platform);
  });

  it('returns undefined for an unregistered id rather than throwing', () => {
    // A user naming a platform the operator never configured is an
    // ordinary outcome; the caller renders the message.
    const registry = new FeedPlatformRegistry([buildFakeFeedPlatform().platform]);

    expect(registry.get('bluesky')).toBeUndefined();
  });

  it('resolves each of several registered platforms independently', () => {
    const first = buildFakeFeedPlatform({ id: 'first' }).platform;
    const second = buildFakeFeedPlatform({ id: 'second' }).platform;
    const registry = new FeedPlatformRegistry([first, second]);

    expect(registry.get('first')).toBe(first);
    expect(registry.get('second')).toBe(second);
  });

  it('rejects duplicate ids at construction', () => {
    // `get` would silently answer with the first, so which of two
    // identically-named platforms serves a subscription would depend on
    // registration order. A programmer error, hence TypeError.
    const platforms = [
      buildFakeFeedPlatform({ id: 'fake' }).platform,
      buildFakeFeedPlatform({ id: 'fake' }).platform,
    ];

    expect(() => new FeedPlatformRegistry(platforms)).toThrow(TypeError);
  });

  it('is unaffected by later mutation of the iterable it was built from', () => {
    const platforms = [buildFakeFeedPlatform({ id: 'fake' }).platform];
    const registry = new FeedPlatformRegistry(platforms);

    platforms.push(buildFakeFeedPlatform({ id: 'late' }).platform);

    expect(registry.get('late')).toBeUndefined();
    expect(registry.get('fake')).toBeDefined();
  });
});
