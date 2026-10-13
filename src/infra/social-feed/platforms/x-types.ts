/**
 * Identity and injection seam shared by the X platform and its timeline
 * client.
 *
 * Shared constants sit here rather than on {@link XPlatform} because
 * the client needs them too — every error it raises names the platform —
 * and importing them from the class would make the pair mutually
 * dependent for shared configuration and identity.
 */
import type { Result } from '../../../core/result';
import { FEED_PLATFORM_DISPLAY_NAMES } from '../types';
import type { FeedFailure, FeedPost, FeedTimelineFetchOptions } from '../types';

/** Registry key for the X platform. */
export const X_PLATFORM_ID = 'x';

/** Public API origin, overridable by the operator for all X feed reads. */
export const DEFAULT_X_API_BASE_URL = 'https://api.fxtwitter.com';

/**
 * Name shown to users and interpolated into `errors:feed.*` messages.
 *
 * Read from the shared map rather than spelled again here: a command
 * that refuses an unconfigured platform has no adapter to ask and falls
 * back to the same map, so two literals would let the configured and
 * unconfigured paths disagree about what the platform is called.
 */
export const X_PLATFORM_DISPLAY_NAME = FEED_PLATFORM_DISPLAY_NAMES[X_PLATFORM_ID];

/**
 * One way of reading an X account's recent posts.
 *
 * Kept as an interface even though {@link FxTwitterTimelineSource} is
 * the only implementation: the reachable ways to read an X timeline
 * differ sharply in cost and stability (a third-party public mirror
 * today, X's metered official API tomorrow), and this seam is also what
 * lets `XPlatform` be unit-tested without a network. It is internal to
 * the X platform, not a second global Strategy — {@link FeedPlatform}
 * is the abstraction the plugin and the commands see.
 */
export interface XTimelineSource {
  /**
   * Read `account`'s recent posts. `Ok([])` means "nothing new", which
   * is the common case for a poller and must not be treated as an error.
   */
  fetchTimeline(
    account: string,
    options?: FeedTimelineFetchOptions,
  ): Promise<Result<readonly FeedPost[], FeedFailure>>;
}
