/**
 * `infra/social-feed` barrel.
 *
 * The social-feed platform Strategy lives in the infra layer because of
 * its outbound edge: a platform reads an account's posts over HTTP and
 * `error-translator` maps the failures into the shared domain taxonomy.
 * The platform-neutral rules built on that edge — the registry, the
 * config schema, the baseline cursor — sit here too, since they name
 * `FeedPlatform` (which bars `core`) and are shared by the plugin and
 * the `feed_*` commands, which are sibling layers that may not import
 * each other.
 *
 * The consuming plugin resolves channels and sends through the shared
 * infra/discord renderer; subscription bookkeeping belongs to commands.
 */
export type {
  FeedPlatform,
  FeedPlatformId,
  FeedPost,
  FeedPreview,
  FeedPostMedia,
  FeedFailure,
  FeedTimelineFetchOptions,
} from './types';
export { SUPPORTED_FEED_PLATFORMS, FEED_PLATFORM_DISPLAY_NAMES } from './types';

export { FeedPlatformRegistry } from './registry';
export { createDefaultFeedPlatformRegistry } from './default-registry';

export { FeedPlatformsSchema, parseFeedPlatformsConfig, type FeedPlatformsConfig } from './config';

export { newestPostForBaseline, resolveBaselineCursor, type FeedBaselineCursor } from './baseline';
export { prepareFeedSubscription } from './subscribe';
export { parseFeedAccounts, feedAccountRefusal, MAX_FEED_ACCOUNTS } from './parse-accounts';

export { XPlatform } from './platforms/x-platform';
export { BahamutPlatform } from './platforms/bahamut-platform';
export { normalizeBahamutTargetOffline } from './platforms/bahamut-target';
export { FxTwitterTimelineSource } from './platforms/fxtwitter-source';
export type { XTimelineSource } from './platforms/x-types';
export { translateFeedError, invalidResponseError } from './platforms/error-translator';
