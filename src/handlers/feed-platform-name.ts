/**
 * How to spell a feed platform that has no adapter to ask for its own
 * display name.
 *
 * `FeedPlatform.displayName` is only reachable through the registry,
 * which holds the platforms an operator actually configured. Both
 * `/feed subscribe` (refusing an unconfigured platform) and
 * `/feed unsubscribe` (labelling the accounts it suggests) have to name
 * a platform the registry may not hold, and two handler directories may
 * not import each other — so the fallback lives here, one level up,
 * rather than being written twice.
 */
import {
  FEED_PLATFORM_DISPLAY_NAMES,
  SUPPORTED_FEED_PLATFORMS,
  type FeedPlatformId,
} from '../infra/social-feed';

const isSupportedPlatform = (id: string): id is FeedPlatformId =>
  (SUPPORTED_FEED_PLATFORMS as readonly string[]).includes(id);

/**
 * A shipped-but-unconfigured platform still gets its proper name from
 * the shared map, so every message about it reads the same. Anything
 * else — a stored subscription for a platform this build no longer
 * ships, or a value outside the declared choices — echoes the raw id,
 * which is more useful to whoever has to explain it than a blank.
 */
export const feedPlatformDisplayName = (id: string): string =>
  isSupportedPlatform(id) ? FEED_PLATFORM_DISPLAY_NAMES[id] : id;
