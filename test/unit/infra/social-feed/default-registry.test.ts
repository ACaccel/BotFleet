/**
 * Unit tests for the platforms config parser and the default registry
 * factory — the two pieces that turn an operator's `social_feed` block
 * into the object the plugin and the commands resolve.
 */
import { describe, expect, it } from 'vitest';

import {
  FEED_PLATFORM_DISPLAY_NAMES,
  SUPPORTED_FEED_PLATFORMS,
  createDefaultFeedPlatformRegistry,
  parseFeedPlatformsConfig,
  type FeedPlatformId,
} from '../../../../src/infra/social-feed';
import { buildFeedPost } from '../../../fixtures/social-feed/fake-platform';

describe('parseFeedPlatformsConfig', () => {
  it.each([
    ['an absent block', undefined],
    ['an empty block', {}],
    ['a block with no platforms key', { enabled: true, pollIntervalMs: 300_000 }],
  ])('yields no platforms for %s', (_label, raw) => {
    // The surrounding `social_feed` block is validated strictly by the
    // plugin; this parser must not reject it for carrying those keys.
    expect(parseFeedPlatformsConfig(raw)).toEqual({});
  });

  it('applies the X defaults when the platform is named but left empty', () => {
    expect(parseFeedPlatformsConfig({ platforms: { x: {} } })).toEqual({
      x: {
        apiBaseUrl: 'https://api.fxtwitter.com',
        timeoutMs: 8000,
        embedProxyHost: 'fxtwitter.com',
      },
    });
  });

  it('keeps operator overrides', () => {
    const parsed = parseFeedPlatformsConfig({
      platforms: { x: { apiBaseUrl: 'https://fx.example.invalid', timeoutMs: 3000 } },
    });

    expect(parsed.x?.apiBaseUrl).toBe('https://fx.example.invalid');
    expect(parsed.x?.timeoutMs).toBe(3000);
  });

  it.each([
    ['a non-URL apiBaseUrl', { apiBaseUrl: 'not-a-url' }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['a fractional timeout', { timeoutMs: 1.5 }],
    ['a timeout above the ceiling', { timeoutMs: 60_000 }],
    ['an empty embedProxyHost', { embedProxyHost: '' }],
  ])('rejects %s', (_label, x) => {
    expect(() => parseFeedPlatformsConfig({ platforms: { x } })).toThrow();
  });

  it('rejects an unknown key inside a platform block', () => {
    // `.strict()` is what turns a typo into a boot failure instead of a
    // silently ignored setting.
    expect(() => parseFeedPlatformsConfig({ platforms: { x: { unknownKey: 1 } } })).toThrow();
  });

  it('rejects an unknown platform name', () => {
    expect(() => parseFeedPlatformsConfig({ platforms: { bluesky: {} } })).toThrow();
  });
});

describe('createDefaultFeedPlatformRegistry', () => {
  it('registers nothing when no platform is configured', () => {
    // Legal on its own: "enabled but no platforms" is the plugin
    // config's complaint, not this factory's.
    const registry = createDefaultFeedPlatformRegistry({});

    for (const id of SUPPORTED_FEED_PLATFORMS) expect(registry.get(id)).toBeUndefined();
  });

  it('can register every platform SUPPORTED_FEED_PLATFORMS advertises', () => {
    // That list is where the `platform` command option gets its choices,
    // so an id on it with no branch in the factory would offer users a
    // subscription nothing could ever serve. The exhaustive record makes
    // adding an id without a config block a compile error too.
    const platforms: Record<FeedPlatformId, Record<string, never>> = { x: {} };

    const registry = createDefaultFeedPlatformRegistry(parseFeedPlatformsConfig({ platforms }));

    for (const id of SUPPORTED_FEED_PLATFORMS) expect(registry.get(id)?.id).toBe(id);
  });

  it('registers the X platform when its block is present', () => {
    const registry = createDefaultFeedPlatformRegistry(
      parseFeedPlatformsConfig({ platforms: { x: {} } }),
    );

    expect(registry.get('x')?.id).toBe('x');
    // One spelling everywhere the platform is named to a user.
    expect(registry.get('x')?.displayName).toBe(FEED_PLATFORM_DISPLAY_NAMES.x);
  });

  it('wires the configured embed proxy host into the platform it builds', () => {
    // Without this the factory could pass `apiBaseUrl` where
    // `embedProxyHost` belongs — it type-checks, and every other test
    // here still passes, while Discord receives an unusable link.
    const registry = createDefaultFeedPlatformRegistry(
      parseFeedPlatformsConfig({ platforms: { x: { embedProxyHost: 'proxy.example.invalid' } } }),
    );
    const post = buildFeedPost({ id: '1', url: 'https://x.com/a/status/1' });

    expect(registry.get('x')?.toEmbedUrl(post)).toBe('https://proxy.example.invalid/a/status/1');
  });
});
