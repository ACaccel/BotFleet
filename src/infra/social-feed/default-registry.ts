/**
 * Default {@link FeedPlatformRegistry}, built from the operator's
 * `social_feed.platforms` block. Exposed as a factory so a test can
 * assemble its own registry from fakes without the real platforms.
 *
 * Only platforms the config actually names are registered: an omitted
 * block is how an operator turns a platform off, and an empty registry
 * is legal here. Whether "enabled with no platforms" is a misconfiguration
 * is the plugin config's question, not this factory's.
 *
 * Adding a platform:
 *   1. Implement {@link FeedPlatform} under `./platforms/`.
 *   2. Append its id to `SUPPORTED_FEED_PLATFORMS` in `./types`.
 *   3. Add its options to {@link FeedPlatformsSchema} in `./config`.
 *   4. Add one branch below.
 */
import { FeedPlatformRegistry } from './registry';
import { XPlatform } from './platforms/x-platform';
import type { FeedPlatformsConfig } from './config';
import type { FeedPlatform } from './types';

export const createDefaultFeedPlatformRegistry = (
  platforms: FeedPlatformsConfig,
): FeedPlatformRegistry => {
  const registered: FeedPlatform[] = [];
  if (platforms.x !== undefined) {
    registered.push(
      new XPlatform({
        apiBaseUrl: platforms.x.apiBaseUrl,
        timeoutMs: platforms.x.timeoutMs,
        embedProxyHost: platforms.x.embedProxyHost,
      }),
    );
  }
  return new FeedPlatformRegistry(registered);
};
